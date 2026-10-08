-- 0015_operational_reliability: Keepup sync and notification outbox as crash-safe state machines, a tamper-proof idempotency
-- ledger, history authority, and fail-closed operational writes. Forward-only; nothing is dropped, no row is rewritten.
--
-- Scope (Phase 7H). Nothing here calls Keepup, sends a notification or talks to any external system: the database records
-- what was attempted and what is known, and workers (src/lib/db/workers) drive it through the functions below.
--   1. History authority: audit rows / status events can be forged by any verified actor (a customer could write "invoice.cancel").
--      append_audit / append_status_event now check what the actor is allowed to record.
--   2. keepup_sync: legal transitions only; the worker claims a row under a lease (state 'creating' is committed BEFORE the external
--      call); an expired lease is "outcome unknown" (needs_reconciliation) and is NEVER retried blindly; only a super_admin resolves it.
--   3. notification_outbox: claim / lease / retry with back-off / dead-letter through functions; direct writes are limited to enqueue.
--   4. idempotency_keys: a completed key can no longer be rewritten or deleted by the application role.
--   5. items / cartons / containers / item_photos / invoice_lines: writes through the runtime role require a verified actor
--      (a leaked or injected database credential without the signing key can no longer change operational data).
-- "Operator" paths (table owner / superusers: migrations, imports, ops) are not subject to these guards; the definer functions below
-- run as the owner, so each of them performs its own actor check.

-- ============================== 1. history authority ==================================================================
-- What each kind of actor may RECORD. super_admin and the system/import identities may record anything well-formed; staff only
-- operational history; a customer only their own profile update; the integration worker only keepup/notification history.
CREATE FUNCTION movezz_sec.history_allowed(p_kind text, p_actor_type text, p_role text, p_name text, p_entity_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_actor_type IS NULL THEN false
    WHEN p_actor_type IN ('system', 'import') THEN true
    WHEN p_actor_type = 'integration' THEN
      CASE WHEN p_kind = 'audit' THEN p_name ~ '^(keepup|notification)\.' AND p_entity_type IN ('keepup_sync', 'notification', 'invoice')
           ELSE p_entity_type = 'keepup_sync' END
    WHEN p_role = 'super_admin' THEN true
    WHEN p_role = 'warehouse_staff' THEN
      CASE WHEN p_kind = 'audit' THEN p_name ~ '^(item|carton|container)\.' AND p_entity_type IN ('item', 'carton', 'container')
           ELSE p_entity_type IN ('item', 'carton', 'container') END
    WHEN p_role = 'customer' THEN p_kind = 'audit' AND p_name = 'customer.update_self' AND p_entity_type = 'customer'
    ELSE false END
$$;
REVOKE ALL ON FUNCTION movezz_sec.history_allowed(text, text, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION movezz_sec.append_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb,
                                                   p_ip inet DEFAULT NULL, p_user_agent text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s movezz_sec.actor_sessions; v bigint;
BEGIN
  SELECT * INTO s FROM movezz_sec.actor_sessions x WHERE x.txid = pg_current_xact_id_if_assigned();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an authenticated actor is required to write an audit record' USING ERRCODE = 'MV007';
  END IF;
  IF p_action IS NULL OR p_action !~ '\S' OR length(p_action) > 120 OR p_entity_type IS NULL OR length(p_entity_type) > 60 THEN
    RAISE EXCEPTION 'invalid audit record' USING ERRCODE = 'MV006';
  END IF;
  IF NOT movezz_sec.history_allowed('audit', s.actor_type, s.role, p_action, p_entity_type)
     OR (s.role = 'customer' AND p_entity_id IS DISTINCT FROM s.customer_id::text) THEN
    RAISE EXCEPTION 'this actor may not record "%" history', p_action USING ERRCODE = 'MV012';
  END IF;
  INSERT INTO public.audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data, request_id, ip_address, user_agent)
  VALUES (s.user_id, s.actor_type, p_action, p_entity_type, p_entity_id, p_before, p_after, s.request_id, p_ip, p_user_agent)
  RETURNING id INTO v;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION movezz_sec.append_status_event(p_entity_type text, p_entity_id uuid, p_old text, p_new text,
                                                          p_reason text DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s movezz_sec.actor_sessions; v bigint;
BEGIN
  SELECT * INTO s FROM movezz_sec.actor_sessions x WHERE x.txid = pg_current_xact_id_if_assigned();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an authenticated actor is required to write a status event' USING ERRCODE = 'MV007';
  END IF;
  IF NOT movezz_sec.history_allowed('status', s.actor_type, s.role, p_new, p_entity_type) THEN
    RAISE EXCEPTION 'this actor may not record % status history', p_entity_type USING ERRCODE = 'MV012';
  END IF;
  INSERT INTO public.status_events (entity_type, entity_id, old_status, new_status, actor_user_id, actor_type, reason, metadata)
  VALUES (p_entity_type, p_entity_id, p_old, p_new, s.user_id, s.actor_type, p_reason, p_metadata)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- ============================== shared helpers ========================================================================
CREATE FUNCTION movezz_sec.require_service_actor() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text := movezz_sec.current_actor_type();
BEGIN
  IF v IS NULL OR v NOT IN ('integration', 'system') THEN
    RAISE EXCEPTION 'this operation is reserved for the integration worker identity' USING ERRCODE = 'MV012';
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.require_service_actor() FROM PUBLIC;

CREATE FUNCTION movezz_sec.require_super_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'only a super_admin may perform this operation' USING ERRCODE = 'MV012';
  END IF;
  RETURN movezz_sec.current_actor_id();
END $$;
REVOKE ALL ON FUNCTION movezz_sec.require_super_admin() FROM PUBLIC;

-- capped exponential back-off in seconds: 30, 60, 120 ... max 3600
CREATE FUNCTION movezz_sec.backoff_seconds(p_attempt integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT least(3600, 30 * (2 ^ least(greatest(coalesce(p_attempt, 1) - 1, 0), 7))::integer)
$$;
REVOKE ALL ON FUNCTION movezz_sec.backoff_seconds(integer) FROM PUBLIC;

-- ============================== 2. Keepup sync: lease, state machine ==================================================
ALTER TABLE keepup_sync
  ADD COLUMN lease_token      uuid,
  ADD COLUMN lease_owner      text CHECK (length(lease_owner) <= 80),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN max_attempts     integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN resolved_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN resolved_at      timestamptz,
  ADD COLUMN resolution_note  text CHECK (length(resolution_note) <= 1000);
-- a Keepup invoice sale is only "synced" when we hold its sale id (NOT VALID: applies to every new/changed row, no table scan)
ALTER TABLE keepup_sync ADD CONSTRAINT keepup_sync_synced_sale_chk CHECK (sync_state <> 'synced' OR kind <> 'invoice' OR keepup_sale_id IS NOT NULL) NOT VALID;
CREATE INDEX keepup_sync_lease_idx ON keepup_sync (lease_expires_at) WHERE sync_state = 'creating';

-- Direct writes through the runtime role (the application, a super_admin, the worker's own SQL) are limited to: enqueueing a row,
-- cancelling work that never reached Keepup, flagging uncertainty, and harmless descriptive columns. Everything that moves a row
-- through the worker lifecycle (claim, complete, fail, reap, resolve, retry) happens in the definer functions below, which run as
-- the owner and therefore are not subject to this trigger.
CREATE FUNCTION movezz_sec.keepup_sync_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.sync_state NOT IN ('pending', 'not_required') OR NEW.attempt_count <> 0 OR NEW.keepup_sale_id IS NOT NULL
       OR NEW.lease_token IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.last_success_at IS NOT NULL THEN
      RAISE EXCEPTION 'A Keepup sync row starts as pending (or not_required) with no attempts, sale id or lease' USING ERRCODE = 'MV005';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.keepup_sale_id IS DISTINCT FROM OLD.keepup_sale_id
     OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at
     OR NEW.last_success_at IS DISTINCT FROM OLD.last_success_at OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
     OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
     OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'These Keepup sync fields are changed only by the sync functions' USING ERRCODE = 'MV004';
  END IF;
  IF NEW.sync_state IS DISTINCT FROM OLD.sync_state THEN
    IF NOT ((OLD.sync_state IN ('pending', 'failed') AND NEW.sync_state = 'cancelled')
         OR (OLD.sync_state IN ('pending', 'failed', 'creating', 'synced') AND NEW.sync_state = 'needs_reconciliation')) THEN
      RAISE EXCEPTION 'Keepup sync state % -> % is not allowed here', OLD.sync_state, NEW.sync_state USING ERRCODE = 'MV005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.keepup_sync_state_guard() FROM PUBLIC;
CREATE TRIGGER keepup_sync_zz_state_guard BEFORE INSERT OR UPDATE ON keepup_sync FOR EACH ROW EXECUTE FUNCTION movezz_sec.keepup_sync_state_guard();

-- claim: pending/failed rows that are due become 'creating' under a fresh lease. The state is COMMITTED by the caller before it
-- contacts Keepup, so a crash at any later point leaves a row that says "an attempt may be in flight".
CREATE FUNCTION movezz_sec.keepup_claim(p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120, p_owner text DEFAULT NULL)
RETURNS TABLE (id uuid, invoice_id uuid, lease_token uuid, attempt_count integer, idempotency_key text, max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.keepup_sync; v_token uuid;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600
     OR p_owner IS NULL OR p_owner !~ '^[A-Za-z0-9._:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = 'MV006';
  END IF;
  FOR r IN
    SELECT k.* FROM public.keepup_sync k JOIN public.invoices i ON i.id = k.invoice_id
     WHERE k.kind = 'invoice' AND k.sync_state IN ('pending', 'failed') AND coalesce(k.next_retry_at, '-infinity'::timestamptz) <= now()
       AND k.attempt_count < k.max_attempts AND i.status <> 'Cancelled' AND i.total_ghs > 0
     ORDER BY coalesce(k.next_retry_at, k.created_at), k.id LIMIT p_limit
     FOR UPDATE OF k SKIP LOCKED
  LOOP
    v_token := gen_random_uuid();
    UPDATE public.keepup_sync k SET sync_state = 'creating', attempt_count = k.attempt_count + 1, last_attempt_at = now(), lease_token = v_token,
           lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds), next_retry_at = NULL
     WHERE k.id = r.id;
    PERFORM movezz_sec.append_status_event_internal('keepup_sync', r.id, r.sync_state, 'creating', 'claimed by ' || p_owner);
    id := r.id; invoice_id := r.invoice_id; lease_token := v_token; attempt_count := r.attempt_count + 1;
    idempotency_key := r.idempotency_key; max_attempts := r.max_attempts;
    RETURN NEXT;
  END LOOP;
END $$;

-- success: requires the lease token of THIS attempt. A late success that arrives after the lease was reaped (needs_reconciliation) is
-- accepted - the worker holds the real response - unless an operator already resolved the row (which clears the token).
CREATE FUNCTION movezz_sec.keepup_complete(p_id uuid, p_token uuid, p_sale_id text, p_external_status text DEFAULT NULL,
                                           p_link text DEFAULT NULL, p_meta jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; inv public.invoices; v_invoice uuid;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_sale_id IS NULL OR btrim(p_sale_id) = '' OR length(p_sale_id) > 100 THEN RAISE EXCEPTION 'a Keepup sale id is required' USING ERRCODE = 'MV006'; END IF;
  -- lock order shared with cancelInvoice: invoice first, then the sync row (otherwise a cancellation and a completion deadlock)
  SELECT s.invoice_id INTO v_invoice FROM public.keepup_sync s WHERE s.id = p_id AND s.kind = 'invoice';
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = v_invoice FOR UPDATE;
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind = 'invoice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token OR k.sync_state NOT IN ('creating', 'needs_reconciliation') THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  BEGIN
    IF inv.status = 'Cancelled' THEN
      -- the sale exists in Keepup although the invoice was cancelled meanwhile: keep the evidence, never report success
      UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', keepup_sale_id = p_sale_id, lease_token = NULL, lease_expires_at = NULL,
             last_error = 'The Keepup sale was created after the invoice was cancelled in Movezz; cancel it in Keepup manually', response_meta = p_meta
       WHERE id = p_id;
      PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, k.sync_state, 'needs_reconciliation', 'sale created after cancellation');
      RETURN 'needs_reconciliation';
    END IF;
    UPDATE public.keepup_sync SET sync_state = 'synced', keepup_sale_id = p_sale_id, external_status = p_external_status, last_success_at = now(),
           last_error = NULL, next_retry_at = NULL, lease_token = NULL, lease_expires_at = NULL, response_meta = p_meta
     WHERE id = p_id;
    UPDATE public.invoices SET keepup_sale_id = p_sale_id, keepup_link = p_link WHERE id = k.invoice_id AND keepup_sale_id IS NULL;
    PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, k.sync_state, 'synced', NULL);
    RETURN 'synced';
  EXCEPTION WHEN unique_violation THEN
    -- the sale id is already attached to another invoice: never overwrite, never claim success
    UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', lease_token = NULL, lease_expires_at = NULL,
           last_error = 'Keepup returned a sale id that is already attached to another invoice'
     WHERE id = p_id;
    PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, k.sync_state, 'needs_reconciliation', 'duplicate sale id');
    RETURN 'needs_reconciliation';
  END;
END $$;

-- definite failure (Keepup rejected the request: nothing was created) -> retry with back-off, or park as 'failed' with no schedule
CREATE FUNCTION movezz_sec.keepup_fail(p_id uuid, p_token uuid, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; v_next timestamptz;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind = 'invoice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'creating' OR k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  v_next := CASE WHEN k.attempt_count >= k.max_attempts THEN NULL ELSE now() + make_interval(secs => movezz_sec.backoff_seconds(k.attempt_count)) END;
  UPDATE public.keepup_sync SET sync_state = 'failed', last_error = left(coalesce(p_error, 'unknown error'), 2000), next_retry_at = v_next,
         lease_token = NULL, lease_expires_at = NULL WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'creating', 'failed', CASE WHEN v_next IS NULL THEN 'retries exhausted' END);
  RETURN 'failed';
END $$;

-- ambiguous outcome (timeout, 5xx, connection lost after the request left, 2xx without a sale id): the sale MAY exist.
-- Never retried automatically. The token is kept so a late, authoritative success from the same attempt can still be recorded.
CREATE FUNCTION movezz_sec.keepup_ambiguous(p_id uuid, p_token uuid, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind = 'invoice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'creating' OR k.lease_token IS NULL OR p_token IS NULL OR k.lease_token <> p_token THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the sync row' USING ERRCODE = 'MV005';
  END IF;
  UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', last_error = left(coalesce(p_error, 'outcome unknown'), 2000),
         next_retry_at = NULL, lease_expires_at = NULL WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'creating', 'needs_reconciliation', 'outcome unknown');
  RETURN 'needs_reconciliation';
END $$;

-- crash recovery: a lease that expired means the worker died (or hung) after committing 'creating'. We cannot know whether the sale
-- was created, so the row goes to reconciliation - never back to pending.
CREATE FUNCTION movezz_sec.keepup_reap_expired(p_limit integer DEFAULT 50) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid limit' USING ERRCODE = 'MV006'; END IF;
  FOR r IN SELECT id FROM public.keepup_sync WHERE sync_state = 'creating'
                 AND coalesce(lease_expires_at, coalesce(last_attempt_at, updated_at) + interval '10 minutes') < now()   -- rows from before leases existed expire too
               ORDER BY coalesce(lease_expires_at, updated_at), id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    -- lease_expires_at is KEPT: it is the proof that any in-flight call has ended, which keepup_resolve('not_created') requires
    UPDATE public.keepup_sync SET sync_state = 'needs_reconciliation', next_retry_at = NULL,
           last_error = 'The worker lease expired after the attempt was started; whether Keepup created the sale is unknown'
     WHERE id = r.id;
    PERFORM movezz_sec.append_status_event_internal('keepup_sync', r.id, 'creating', 'needs_reconciliation', 'lease expired');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- manual administration (A4): super_admin only, always with a reason, always audited
CREATE FUNCTION movezz_sec.keepup_resolve(p_id uuid, p_outcome text, p_sale_id text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; inv public.invoices; v_actor uuid := movezz_sec.require_super_admin(); v_new text; v_invoice uuid;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'a resolution reason is required' USING ERRCODE = 'MV006'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('created', 'not_created', 'cancelled') THEN RAISE EXCEPTION 'unknown outcome' USING ERRCODE = 'MV006'; END IF;
  SELECT s.invoice_id INTO v_invoice FROM public.keepup_sync s WHERE s.id = p_id AND s.kind = 'invoice';
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = v_invoice FOR UPDATE;                  -- lock order: invoice, then sync row
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind = 'invoice' FOR UPDATE;
  IF k.sync_state <> 'needs_reconciliation' THEN RAISE EXCEPTION 'only a row awaiting reconciliation can be resolved' USING ERRCODE = 'MV005'; END IF;
  IF p_outcome = 'created' THEN
    IF p_sale_id IS NULL OR btrim(p_sale_id) = '' OR length(p_sale_id) > 100 THEN RAISE EXCEPTION 'the verified Keepup sale id is required' USING ERRCODE = 'MV006'; END IF;
    IF inv.status = 'Cancelled' THEN RAISE EXCEPTION 'the invoice is cancelled: cancel the Keepup sale manually, then resolve as cancelled' USING ERRCODE = 'MV005'; END IF;
    v_new := 'synced';
  ELSIF p_outcome = 'not_created' THEN
    -- "nothing was created" cannot be asserted while the original call could still be in flight: the lease (plus a grace period) must be over
    IF k.lease_expires_at IS NOT NULL AND now() < k.lease_expires_at + interval '5 minutes' THEN
      RAISE EXCEPTION 'the original attempt may still be in flight (lease ends %); verify again after the grace period', k.lease_expires_at USING ERRCODE = 'MV005';
    END IF;
    IF inv.status = 'Cancelled' THEN v_new := 'cancelled'; ELSE v_new := 'pending'; END IF;
  ELSE
    v_new := 'cancelled';
  END IF;
  UPDATE public.keepup_sync SET sync_state = v_new, resolved_by = v_actor, resolved_at = now(), resolution_note = p_reason,
         lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
         keepup_sale_id = CASE WHEN p_outcome = 'created' THEN p_sale_id WHEN p_outcome = 'cancelled' AND p_sale_id IS NOT NULL THEN coalesce(k.keepup_sale_id, p_sale_id) ELSE k.keepup_sale_id END,
         last_success_at = CASE WHEN p_outcome = 'created' THEN now() ELSE k.last_success_at END,
         next_retry_at = CASE WHEN v_new = 'pending' THEN now() END,
         max_attempts = CASE WHEN v_new = 'pending' THEN greatest(k.max_attempts, least(20, k.attempt_count + 1)) ELSE k.max_attempts END
   WHERE id = p_id;
  IF p_outcome = 'created' THEN UPDATE public.invoices SET keepup_sale_id = p_sale_id WHERE id = k.invoice_id AND keepup_sale_id IS NULL; END IF;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'needs_reconciliation', v_new, p_reason);
  PERFORM movezz_sec.append_audit('keepup.resolve', 'keepup_sync', p_id::text, jsonb_build_object('sync_state', 'needs_reconciliation'),
          jsonb_build_object('sync_state', v_new, 'outcome', p_outcome, 'sale_id', p_sale_id, 'reason', p_reason, 'invoice_id', k.invoice_id));
END $$;

CREATE FUNCTION movezz_sec.keepup_manual_retry(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k public.keepup_sync; v_actor uuid := movezz_sec.require_super_admin();
BEGIN
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'a retry reason is required' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO k FROM public.keepup_sync WHERE id = p_id AND kind = 'invoice' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Keepup sync row not found' USING ERRCODE = 'MV006'; END IF;
  IF k.sync_state <> 'failed' THEN RAISE EXCEPTION 'only a failed sync can be retried (an unknown outcome must be reconciled)' USING ERRCODE = 'MV005'; END IF;
  IF k.attempt_count >= 20 THEN RAISE EXCEPTION 'the retry budget is exhausted; reconcile manually' USING ERRCODE = 'MV005'; END IF;
  UPDATE public.keepup_sync SET sync_state = 'pending', next_retry_at = now(), max_attempts = greatest(k.max_attempts, least(20, k.attempt_count + 3)),
         resolved_by = v_actor, resolved_at = now(), resolution_note = p_reason WHERE id = p_id;
  PERFORM movezz_sec.append_status_event_internal('keepup_sync', p_id, 'failed', 'pending', p_reason);
  PERFORM movezz_sec.append_audit('keepup.retry', 'keepup_sync', p_id::text, jsonb_build_object('sync_state', 'failed'),
          jsonb_build_object('sync_state', 'pending', 'reason', p_reason, 'invoice_id', k.invoice_id));
END $$;

-- ============================== 3. notification outbox ================================================================
ALTER TABLE notification_outbox
  ADD COLUMN lease_token      uuid,
  ADD COLUMN lease_owner      text CHECK (length(lease_owner) <= 80),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN max_attempts     integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN provider_ref     text CHECK (length(provider_ref) <= 200);
CREATE INDEX outbox_lease_idx ON notification_outbox (lease_expires_at) WHERE status = 'sending';

CREATE FUNCTION movezz_sec.outbox_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Outbox rows are never deleted' USING ERRCODE = 'MV004'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM movezz_sec.require_actor();                                  -- no verified actor, no enqueue
    IF NEW.status <> 'pending' OR NEW.attempts <> 0 OR NEW.sent_at IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.provider_ref IS NOT NULL THEN
      RAISE EXCEPTION 'An outbox row is enqueued as pending with no attempts' USING ERRCODE = 'MV005';
    END IF;
    IF length(NEW.recipient) > 320 OR (NEW.channel = 'email' AND NEW.recipient !~ '^[^@\s]+@[^@\s]+$') OR pg_column_size(NEW.payload) > 16384 THEN
      RAISE EXCEPTION 'Invalid outbox recipient or oversized payload' USING ERRCODE = 'MV006';
    END IF;
    RETURN NEW;
  END IF;
  -- direct UPDATE: only "cancel something that has not been sent" (pending/failed -> cancelled), by a super_admin or the service identity
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('pending', 'failed') AND NEW.status = 'cancelled'
     AND (movezz_sec.actor_role() = 'super_admin' OR movezz_sec.current_actor_type() IN ('integration', 'system'))
     AND (to_jsonb(NEW) - 'status' - 'updated_at' - 'last_error') = (to_jsonb(OLD) - 'status' - 'updated_at' - 'last_error') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Outbox rows are changed only by the outbox functions' USING ERRCODE = 'MV004';
END $$;
REVOKE ALL ON FUNCTION movezz_sec.outbox_state_guard() FROM PUBLIC;
CREATE TRIGGER outbox_zz_state_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION movezz_sec.outbox_state_guard();

CREATE FUNCTION movezz_sec.outbox_claim(p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120, p_owner text DEFAULT NULL)
RETURNS TABLE (id uuid, event_type text, channel text, recipient text, payload jsonb, attempts integer, lease_token uuid, dedupe_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.notification_outbox; v_token uuid;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600
     OR p_owner IS NULL OR p_owner !~ '^[A-Za-z0-9._:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid claim parameters' USING ERRCODE = 'MV006';
  END IF;
  FOR r IN
    SELECT o.* FROM public.notification_outbox o
     WHERE o.status IN ('pending', 'failed') AND o.next_attempt_at <= now() AND o.attempts < o.max_attempts
     ORDER BY o.next_attempt_at, o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    v_token := gen_random_uuid();
    UPDATE public.notification_outbox o SET status = 'sending', attempts = o.attempts + 1, lease_token = v_token, lease_owner = p_owner,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds) WHERE o.id = r.id;
    id := r.id; event_type := r.event_type; channel := r.channel; recipient := r.recipient; payload := r.payload;
    attempts := r.attempts + 1; lease_token := v_token; dedupe_key := r.dedupe_key;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION movezz_sec.outbox_complete(p_id uuid, p_token uuid, p_provider_ref text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.notification_outbox;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO o FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outbox row not found' USING ERRCODE = 'MV006'; END IF;
  IF o.status = 'sent' AND o.lease_token IS NOT DISTINCT FROM p_token THEN RETURN 'sent'; END IF;               -- idempotent completion
  -- a late success after the lease was reaped ('failed' keeps the token of the attempt that really sent it) is accepted
  IF o.lease_token IS NULL OR p_token IS NULL OR o.lease_token <> p_token OR o.status NOT IN ('sending', 'failed') THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the outbox row' USING ERRCODE = 'MV005';
  END IF;
  UPDATE public.notification_outbox SET status = 'sent', sent_at = now(), last_error = NULL, provider_ref = left(p_provider_ref, 200),
         lease_expires_at = NULL WHERE id = p_id;
  RETURN 'sent';
END $$;

CREATE FUNCTION movezz_sec.outbox_fail(p_id uuid, p_token uuid, p_error text, p_permanent boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.notification_outbox; v_status text;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  SELECT * INTO o FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outbox row not found' USING ERRCODE = 'MV006'; END IF;
  IF o.status <> 'sending' OR o.lease_token IS NULL OR p_token IS NULL OR o.lease_token <> p_token THEN
    RAISE EXCEPTION 'this attempt no longer holds the lease for the outbox row' USING ERRCODE = 'MV005';
  END IF;
  v_status := CASE WHEN coalesce(p_permanent, false) OR o.attempts >= o.max_attempts THEN 'dead' ELSE 'failed' END;
  UPDATE public.notification_outbox SET status = v_status, last_error = left(coalesce(p_error, 'unknown error'), 2000), lease_expires_at = NULL,
         lease_token = CASE WHEN v_status = 'dead' THEN NULL ELSE lease_token END,
         next_attempt_at = now() + make_interval(secs => movezz_sec.backoff_seconds(o.attempts)) WHERE id = p_id;
  RETURN v_status;
END $$;

-- crash recovery: an expired 'sending' lease goes back to 'failed' (retry soon) or 'dead'. The token stays so that a late success is not
-- lost; a retry by another worker gets a new token. At-least-once: a send that succeeded right before the crash may be repeated
-- unless the provider de-duplicates on the row id (the sender passes it as the provider idempotency key).
CREATE FUNCTION movezz_sec.outbox_reap_expired(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.notification_outbox; n integer := 0;
BEGIN
  PERFORM movezz_sec.require_service_actor();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid limit' USING ERRCODE = 'MV006'; END IF;
  FOR r IN SELECT * FROM public.notification_outbox WHERE status = 'sending' AND coalesce(lease_expires_at, updated_at + interval '10 minutes') < now()
               ORDER BY coalesce(lease_expires_at, updated_at), id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.notification_outbox SET status = CASE WHEN r.attempts >= r.max_attempts THEN 'dead' ELSE 'failed' END, lease_expires_at = NULL,
           last_error = 'The sender lease expired; delivery state is unknown', next_attempt_at = now() WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION movezz_sec.outbox_requeue_dead(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o public.notification_outbox; v_actor uuid := movezz_sec.require_super_admin();
BEGIN
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO o FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Outbox row not found' USING ERRCODE = 'MV006'; END IF;
  IF o.status <> 'dead' THEN RAISE EXCEPTION 'only a dead notification can be requeued' USING ERRCODE = 'MV005'; END IF;
  UPDATE public.notification_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), lease_token = NULL, lease_expires_at = NULL,
         last_error = NULL WHERE id = p_id;
  PERFORM movezz_sec.append_audit('notification.requeue', 'notification', p_id::text, jsonb_build_object('status', 'dead'),
          jsonb_build_object('status', 'pending', 'reason', p_reason, 'actor', v_actor));
END $$;

-- ============================== 4. idempotency ledger =================================================================
CREATE FUNCTION movezz_sec.idempotency_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Idempotency keys are not deleted by the application' USING ERRCODE = 'MV004'; END IF;
  IF OLD.status <> 'in_progress' OR NEW.status NOT IN ('completed', 'failed')
     OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'A recorded idempotency result cannot be changed' USING ERRCODE = 'MV004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.idempotency_ledger_guard() FROM PUBLIC;
CREATE TRIGGER idempotency_zz_ledger_guard BEFORE UPDATE OR DELETE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION movezz_sec.idempotency_ledger_guard();

-- (Expired keys are purged by the operator script scripts/db-purge-idempotency.mjs, never by the application role or a migration.)

-- ============================== 5. operational writes need a verified actor ===========================================
CREATE FUNCTION movezz_sec.operational_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  PERFORM movezz_sec.require_actor();                                    -- MV007 without a verified actor
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION movezz_sec.operational_write_guard() FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['items', 'cartons', 'containers', 'item_photos', 'invoice_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION movezz_sec.operational_write_guard()', 'a0_' || t || '_requires_actor', t);
  END LOOP;
END $$;

-- ============================== runtime grants ========================================================================
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA movezz_sec FROM PUBLIC;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA movezz_sec FROM PUBLIC;   -- (re-asserted after the grants: nothing in the private schema is PUBLIC)
