-- 0019_keepup_propagation: Keepup payments and sale cancellation as durable, ordered, recoverable operations.
--
-- The invoice-creation state machine (0015) is untouched. Two more kinds of row use the same table, lease, back-off and reconciliation rules:
--   kind 'payment'  one row per Movezz payment that originated in Movezz (source <> 'keepup'): PUT /sales/balance/{sale} (amount in GHS)
--   kind 'cancel'   one row per cancelled invoice whose Keepup sale exists:                       PUT /sales/cancel/{sale}
-- Rules (each enforced here, in SQL, and tested):
--   * nothing is sent until the invoice's Keepup sale exists (invoices.keepup_sale_id)
--   * one operation in flight per invoice; payments go out in creation order; a failed/unresolved earlier payment blocks later ones
--   * a cancel waits until every payment operation of that invoice is finished (synced/cancelled): an unresolved payment needs a person first
--   * Keepup documents no idempotency key, so an ambiguous outcome is NEVER re-sent: it parks in needs_reconciliation for a person
--   * a payment voided in Movezz before it was sent is cancelled locally; voided after it was sent is flagged for manual reversal in Keepup
--   * a late success for a payment that was voided meanwhile is kept as evidence in needs_reconciliation, never reported as synced
-- No data is rewritten and no existing function is changed (apply_runtime_grants only gains the new EXECUTE grants).
ALTER TABLE keepup_sync DROP CONSTRAINT keepup_sync_kind_check;
ALTER TABLE keepup_sync ADD CONSTRAINT keepup_sync_kind_check CHECK (kind IN ('invoice','payment','cancel'));
CREATE UNIQUE INDEX keepup_sync_cancel_uidx ON keepup_sync (invoice_id) WHERE kind = 'cancel';
CREATE INDEX keepup_sync_op_due_idx ON keepup_sync (next_retry_at) WHERE kind IN ('payment','cancel') AND sync_state IN ('pending','failed');

-- claim: due payment/cancel rows whose preconditions hold become 'creating' under a fresh lease (committed BEFORE Keepup is contacted).
CREATE FUNCTION movezz_sec.keepup_op_claim(p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120, p_owner text DEFAULT NULL)
RETURNS TABLE (id uuid, kind text, invoice_id uuid, payment_id uuid, sale_id text, lease_token uuid, attempt_count integer, idempotency_key text, max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.keepup_sync; v_token uuid; v_sale text;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600
     OR p_owner IS NULL OR p_owner !~ '^[A-Za-z0-9._:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = 'MV006';
  END IF;
  FOR r IN
    SELECT k.* FROM public.keepup_sync k JOIN public.invoices i ON i.id = k.invoice_id LEFT JOIN public.payments p ON p.id = k.payment_id
     WHERE k.kind IN ('payment', 'cancel') AND k.sync_state IN ('pending', 'failed') AND coalesce(k.next_retry_at, '-infinity'::timestamptz) <= now()
       AND k.attempt_count < k.max_attempts AND i.keepup_sale_id IS NOT NULL
       AND ((k.kind = 'payment' AND p.status = 'completed' AND i.status <> 'Cancelled') OR (k.kind = 'cancel' AND i.status = 'Cancelled'))
       AND NOT EXISTS (
         SELECT 1 FROM public.keepup_sync o
          WHERE o.invoice_id = k.invoice_id AND o.id <> k.id AND o.kind IN ('payment', 'cancel') AND o.sync_state IN ('pending', 'failed', 'creating', 'needs_reconciliation')
            AND ( (k.kind = 'payment' AND o.sync_state = 'creating')                                                   -- one in flight per invoice
               OR (k.kind = 'payment' AND o.kind = 'payment' AND (o.created_at, o.id) < (k.created_at, k.id))         -- strict creation order; an unresolved earlier payment blocks
               OR (k.kind = 'cancel' AND o.kind = 'payment') ))                                                         -- cancel only after every payment operation is finished
     ORDER BY coalesce(k.next_retry_at, k.created_at), k.created_at, k.id LIMIT p_limit
     FOR UPDATE OF k SKIP LOCKED
  LOOP
    v_token := gen_random_uuid();
    SELECT i2.keepup_sale_id INTO v_sale FROM public.invoices i2 WHERE i2.id = r.invoice_id;
    UPDATE public.keepup_sync k SET sync_state = 'creating', attempt_count = k.attempt_count + 1, last_attempt_at = now(), lease_token = v_token,
           lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds), next_retry_at = NULL, keepup_sale_id = v_sale
     WHERE k.id = r.id;
    PERFORM movezz_sec.append_status_event_internal('keepup_sync', r.id, r.sync_state, 'creating', 'claimed by ' || p_owner);
    id := r.id; kind := r.kind; invoice_id := r.invoice_id; payment_id := r.payment_id; sale_id := v_sale; lease_token := v_token;
    attempt_count := r.attempt_count + 1; idempotency_key := r.idempotency_key; max_attempts := r.max_attempts;
    RETURN NEXT;
  END LOOP;
END $$;

-- success: requires the lease token of THIS attempt (a late success after the lease was reaped is accepted: the worker holds the real response)
CREATE FUNCTION movezz_sec.keepup_op_complete(p_id uuid, p_token uuid, p_meta jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; inv public.invoices; v_invoice uuid; v_pay text;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT s.invoice_id INTO v_invoice FROM public.keepup_sync s WHERE s.id = p_id AND s.kind IN ('payment', 'cancel');
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = v_invoice FOR UPDATE;                         -- lock order: invoice, then sync rows
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind IN ('payment', 'cancel') FOR UPDATE;
  IF k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token OR k.sync_state NOT IN ('creating', 'needs_reconciliation') THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  IF k.kind = 'payment' THEN
    SELECT status INTO v_pay FROM public.payments WHERE id = k.payment_id;
    IF v_pay IS DISTINCT FROM 'completed' THEN
      UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', lease_token = NULL, lease_expires_at = NULL, response_meta = p_meta,
             last_error = 'The payment was recorded in Keepup although it was voided in Movezz meanwhile; reverse it in Keepup manually'
       WHERE id = p_id;
      PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, k.sync_state, 'needs_reconciliation', 'payment applied after void');
      RETURN 'needs_reconciliation';
    END IF;
  END IF;
  UPDATE public.keepup_sync SET sync_state = 'synced', last_success_at = now(), last_error = NULL, next_retry_at = NULL, lease_token = NULL, lease_expires_at = NULL, response_meta = p_meta
   WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, k.sync_state, 'synced', NULL);
  IF k.kind = 'cancel' THEN
    -- the invoice's own sync row was parked for reconciliation when the invoice was cancelled; the sale is now cancelled in Keepup
    UPDATE public.keepup_sync SET sync_state = 'cancelled', last_error = NULL, resolution_note = 'Keepup sale cancelled by the worker', resolved_at = now()
     WHERE invoice_id = k.invoice_id AND kind = 'invoice' AND sync_state = 'needs_reconciliation' AND keepup_sale_id = k.keepup_sale_id;
    IF FOUND THEN PERFORM movezz_sec.append_status_event_internal('keepup_sync', (SELECT s.id FROM public.keepup_sync s WHERE s.invoice_id = k.invoice_id AND s.kind = 'invoice'), 'needs_reconciliation', 'cancelled', 'Keepup sale cancelled'); END IF;
  END IF;
  RETURN 'synced';
END $$;

-- definite failure (Keepup rejected it: nothing was applied) -> retry with back-off, or park as 'failed' with no schedule
CREATE FUNCTION movezz_sec.keepup_op_fail(p_id uuid, p_token uuid, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; v_next timestamptz;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind IN ('payment', 'cancel') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'creating' OR k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  v_next := CASE WHEN k.attempt_count >= k.max_attempts THEN NULL ELSE now() + make_interval(secs => movezz_sec.backoff_seconds(k.attempt_count)) END;
  UPDATE public.keepup_sync SET sync_state = 'failed', last_error = left(coalesce(p_error, 'unknown error'), 2000), next_retry_at = v_next, lease_token = NULL, lease_expires_at = NULL WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'creating', 'failed', CASE WHEN v_next IS NULL THEN 'retries exhausted' END);
  RETURN 'failed';
END $$;

-- ambiguous outcome (timeout, 5xx, connection lost, redirect): the operation MAY have been applied. Never re-sent automatically.
CREATE FUNCTION movezz_sec.keepup_op_ambiguous(p_id uuid, p_token uuid, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind IN ('payment', 'cancel') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'creating' OR k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', last_error = left(coalesce(p_error, 'outcome unknown'), 2000), next_retry_at = NULL, lease_expires_at = NULL WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'creating', 'needs_reconciliation', 'outcome unknown');
  RETURN 'needs_reconciliation';
END $$;

-- manual administration: super_admin only, always with a reason, always audited
--   applied      a person verified in Keepup that the operation IS there            -> synced   (a voided payment cannot be marked applied: reverse it, then 'abandoned')
--   not_applied  a person verified it is NOT there (after lease + grace)            -> pending  (cancelled when the payment was voided)
--   abandoned    the operation is no longer wanted / was handled by hand            -> cancelled
CREATE FUNCTION movezz_sec.keepup_op_resolve(p_id uuid, p_outcome text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; inv public.invoices; v_actor uuid := movezz_sec.require_super_admin(); v_new text; v_pay text; v_invoice uuid;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'a resolution reason is required' USING ERRCODE = 'MV006'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('applied', 'not_applied', 'abandoned') THEN RAISE EXCEPTION 'unknown outcome' USING ERRCODE = 'MV006'; END IF;
  SELECT s.invoice_id INTO v_invoice FROM public.keepup_sync s WHERE s.id = p_id AND s.kind IN ('payment', 'cancel');
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = v_invoice FOR UPDATE;
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind IN ('payment', 'cancel') FOR UPDATE;
  IF k.sync_state <> 'needs_reconciliation' THEN RAISE EXCEPTION 'only a row awaiting reconciliation can be resolved' USING ERRCODE = 'MV005'; END IF;
  IF k.kind = 'payment' THEN SELECT status INTO v_pay FROM public.payments WHERE id = k.payment_id; END IF;
  IF p_outcome = 'applied' THEN
    IF k.kind = 'payment' AND v_pay IS DISTINCT FROM 'completed' THEN RAISE EXCEPTION 'the payment was voided: reverse it in Keepup manually, then resolve as abandoned' USING ERRCODE = 'MV005'; END IF;
    v_new := 'synced';
  ELSIF p_outcome = 'not_applied' THEN
    IF k.lease_expires_at IS NOT NULL AND now() < k.lease_expires_at + interval '5 minutes' THEN
      RAISE EXCEPTION 'the original attempt may still be in flight (lease ends %); verify again after the grace period', k.lease_expires_at USING ERRCODE = 'MV005';
    END IF;
    v_new := CASE WHEN k.kind = 'payment' AND v_pay IS DISTINCT FROM 'completed' THEN 'cancelled' ELSE 'pending' END;
  ELSE
    v_new := 'cancelled';
  END IF;
  UPDATE public.keepup_sync SET sync_state = v_new, resolved_by = v_actor, resolved_at = now(), resolution_note = p_reason, lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
         last_success_at = CASE WHEN p_outcome = 'applied' THEN now() ELSE k.last_success_at END, next_retry_at = CASE WHEN v_new = 'pending' THEN now() END,
         max_attempts = CASE WHEN v_new = 'pending' THEN greatest(k.max_attempts, least(20, k.attempt_count + 1)) ELSE k.max_attempts END
   WHERE id = p_id;
  IF k.kind = 'cancel' AND v_new = 'synced' THEN
    UPDATE public.keepup_sync SET sync_state = 'cancelled', last_error = NULL, resolution_note = 'Keepup sale cancelled (verified by a person)', resolved_at = now()
     WHERE invoice_id = k.invoice_id AND kind = 'invoice' AND sync_state = 'needs_reconciliation' AND keepup_sale_id = k.keepup_sale_id;
  END IF;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'needs_reconciliation', v_new, p_reason);
  PERFORM movezz_sec.append_audit('keepup.resolve', 'keepup_sync', p_id::text, jsonb_build_object('sync_state', 'needs_reconciliation'),
          jsonb_build_object('sync_state', v_new, 'outcome', p_outcome, 'kind', k.kind, 'reason', p_reason, 'invoice_id', k.invoice_id));
END $$;

CREATE FUNCTION movezz_sec.keepup_op_manual_retry(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; v_actor uuid := movezz_sec.require_super_admin();
BEGIN
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'a retry reason is required' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind IN ('payment', 'cancel') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'failed' THEN RAISE EXCEPTION 'only a failed operation can be retried (an unknown outcome must be reconciled)' USING ERRCODE = 'MV005'; END IF;
  IF k.attempt_count >= 20 THEN RAISE EXCEPTION 'the retry budget is exhausted; reconcile manually' USING ERRCODE = 'MV005'; END IF;
  UPDATE public.keepup_sync SET sync_state = 'pending', next_retry_at = now(), max_attempts = greatest(k.max_attempts, least(20, k.attempt_count + 3)), resolved_by = v_actor, resolved_at = now(), resolution_note = p_reason WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'failed', 'pending', p_reason);
  PERFORM movezz_sec.append_audit('keepup.retry', 'keepup_sync', p_id::text, jsonb_build_object('sync_state', 'failed'), jsonb_build_object('sync_state', 'pending', 'kind', k.kind, 'reason', p_reason, 'invoice_id', k.invoice_id));
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA movezz_sec FROM PUBLIC;
-- apply_runtime_grants: identical to 0015 plus EXECUTE on the six keepup_op_* functions
CREATE OR REPLACE FUNCTION apply_runtime_grants(p_role text DEFAULT 'movezz_app') RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE NOTICE 'role % does not exist; grants skipped', p_role;
    RETURN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  FOREACH t IN ARRAY ARRAY['warehouses','suppliers','package_rates','customers','special_rates',
                           'containers','invoices','cartons','items','item_photos','payments','keepup_sync']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, p_role);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoice_lines','fx_rates']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('REVOKE ALL ON registration_requests FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON registration_requests TO %I', p_role);
  EXECUTE format('REVOKE ALL ON users FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON users TO %I', p_role);
  EXECUTE format('GRANT UPDATE (last_login_at) ON users TO %I', p_role);
  FOREACH t IN ARRAY ARRAY['status_events','audit_logs']
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, p_role);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('GRANT UPDATE (is_active) ON fx_rates TO %I', p_role);
  -- 7H: the ledger and the outbox are never deleted from by the application (retention is an operator job)
  FOREACH t IN ARRAY ARRAY['idempotency_keys','notification_outbox']
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, p_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('REVOKE ALL ON reference_counters FROM %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION allocate_reference(text, text), allocate_container_reference(integer) TO %I', p_role);
  EXECUTE format('GRANT SELECT ON active_customers TO %I', p_role);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', p_role);

  EXECUTE format('GRANT USAGE ON SCHEMA movezz_sec TO %I', p_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA movezz_sec FROM %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION movezz_sec.begin_actor(text, uuid, text, text, bigint, text), movezz_sec.current_actor_id(),
                  movezz_sec.current_actor_type(), movezz_sec.require_actor(),
                  movezz_sec.append_audit(text, text, text, jsonb, jsonb, inet, text),
                  movezz_sec.append_status_event(text, uuid, text, text, text, jsonb), movezz_sec.actor_role(),
                  movezz_sec.actor_customer_id(), movezz_sec.actor_context(), movezz_sec.is_operator(oid, name), movezz_sec.actor_owns_entity(text, uuid),
                  movezz_sec.admin_create_user(text, text, text, text, uuid), movezz_sec.admin_set_user_role(uuid, text, uuid),
                  movezz_sec.admin_set_user_active(uuid, boolean, text),
                  movezz_sec.submit_registration(text, text, text, text, text, text, text, text), movezz_sec.approve_registration(uuid),
                  movezz_sec.reject_registration(uuid, text), movezz_sec.activate_registration(text, text, boolean),
                  movezz_sec.keepup_claim(integer, integer, text), movezz_sec.keepup_complete(uuid, uuid, text, text, text, jsonb),
                  movezz_sec.keepup_fail(uuid, uuid, text), movezz_sec.keepup_ambiguous(uuid, uuid, text), movezz_sec.keepup_reap_expired(integer),
                  movezz_sec.keepup_resolve(uuid, text, text, text), movezz_sec.keepup_manual_retry(uuid, text),
                  movezz_sec.keepup_op_claim(integer, integer, text), movezz_sec.keepup_op_complete(uuid, uuid, jsonb), movezz_sec.keepup_op_fail(uuid, uuid, text),
                  movezz_sec.keepup_op_ambiguous(uuid, uuid, text), movezz_sec.keepup_op_resolve(uuid, text, text), movezz_sec.keepup_op_manual_retry(uuid, text),
                  movezz_sec.outbox_claim(integer, integer, text), movezz_sec.outbox_complete(uuid, uuid, text),
                  movezz_sec.outbox_fail(uuid, uuid, text, boolean), movezz_sec.outbox_reap_expired(integer),
                  movezz_sec.outbox_requeue_dead(uuid, text) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION item_authoritative_price(uuid, uuid), resolve_special_rate(uuid, uuid, timestamptz, text),
                  current_fx_rate(text, text, timestamptz) TO %I', p_role);
  BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), p_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', p_role);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not revoke TEMPORARY/CREATE (not the owner)';
  END;
END $$;
REVOKE ALL ON FUNCTION apply_runtime_grants(text) FROM PUBLIC;
SELECT apply_runtime_grants('movezz_app');
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA movezz_sec FROM PUBLIC;
