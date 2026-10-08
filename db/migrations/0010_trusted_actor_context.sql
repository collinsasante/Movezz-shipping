-- 0010_trusted_actor_context: who performed a mutation is established by a SIGNED, single-use, per-transaction actor
-- assertion verified inside PostgreSQL, and audit/status history can only be written through functions that read that
-- verified actor. See docs/DATABASE-ARCHITECTURE.md "Trusted actor context".
--
-- Threat model. A plain session variable (set_config/current_setting) is NOT trusted: the runtime role can set any value.
-- Here the runtime role cannot mint an actor, because verification needs a secret key that
--   * lives in the SERVER environment (ACTOR_CONTEXT_KEY) and in movezz_sec.actor_keys,
--   * is unreadable by the runtime role (no privileges on the schema's tables),
--   * is never in a migration (provisioned by an operator with movezz_sec.set_actor_key()).
-- Residual risk (stated, not hidden): code that HOLDS the signing key (the application server itself) can sign an
-- assertion for any active user. The design defends against request-body forgery, SQL injection, a leaked runtime DB
-- credential without the key, replay of a captured assertion, and cross-request / pooled-connection leakage.
--
-- Destructive-statement review: no table/column drops, no row deletes or rewrites. Privileges are REVOKED from the
-- runtime role on audit_logs/status_events INSERT (replaced by definer functions) and TEMP/CREATE are withdrawn.

-- ============================== 1. private schema ====================================================================
CREATE SCHEMA movezz_sec;
REVOKE ALL ON SCHEMA movezz_sec FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA movezz_sec REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE movezz_sec.actor_keys (
  id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        bytea NOT NULL CHECK (octet_length(key) >= 32),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT actor_keys_retired_chk CHECK (is_active = (retired_at IS NULL))
);
REVOKE ALL ON movezz_sec.actor_keys FROM PUBLIC;

-- One row per transaction that has established an actor. Keyed by the top-level transaction id, so it can never apply
-- to a later transaction on a pooled connection; rows from rolled-back transactions disappear with them.
CREATE TABLE movezz_sec.actor_sessions (
  txid        xid8 PRIMARY KEY,
  jti         text NOT NULL UNIQUE,                      -- single-use assertion id (replay protection)
  actor_type  text NOT NULL CHECK (actor_type IN ('user','system','integration','import')),
  user_id     uuid REFERENCES public.users (id) ON DELETE RESTRICT,
  role        text,                                      -- copied from public.users at verification time, never from the caller
  customer_id uuid,
  request_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actor_sessions_user_chk CHECK ((actor_type = 'user') = (user_id IS NOT NULL))
);
REVOKE ALL ON movezz_sec.actor_sessions FROM PUBLIC;

-- ============================== 2. HMAC-SHA256 (RFC 2104) on the built-in sha256() ===================================
-- Built-in only: no pgcrypto dependency and no extension schema on the search path to hijack. Verified against RFC 4231
-- test vectors and against Node's crypto in tests/db/actor.test.ts.
CREATE FUNCTION movezz_sec.hmac_sha256(p_key bytea, p_msg bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k    bytea := p_key;
  ikey bytea := decode(repeat('00', 64), 'hex');
  okey bytea := decode(repeat('00', 64), 'hex');
  i    integer;
BEGIN
  IF octet_length(k) > 64 THEN k := sha256(k); END IF;
  k := k || decode(repeat('00', 64 - octet_length(k)), 'hex');
  FOR i IN 0..63 LOOP
    ikey := set_byte(ikey, i, get_byte(k, i) # 54);   -- 0x36
    okey := set_byte(okey, i, get_byte(k, i) # 92);   -- 0x5c
  END LOOP;
  RETURN sha256(okey || sha256(ikey || p_msg));
END $$;

CREATE FUNCTION movezz_sec.assertion_message(p_type text, p_user uuid, p_request_id text, p_jti text, p_exp bigint) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT convert_to('v1|' || p_type || '|' || coalesce(p_user::text, '') || '|' || p_request_id || '|' || p_jti || '|' || p_exp::text, 'UTF8')
$$;

-- ============================== 3. key management (operator only; no EXECUTE for anyone else) ========================
CREATE FUNCTION movezz_sec.set_actor_key(p_key bytea) RETURNS smallint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v smallint;
BEGIN
  IF p_key IS NULL OR octet_length(p_key) < 32 THEN
    RAISE EXCEPTION 'actor key must be at least 32 bytes' USING ERRCODE = 'MV007';
  END IF;
  INSERT INTO movezz_sec.actor_keys (key) VALUES (p_key) RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION movezz_sec.retire_actor_key(p_id smallint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE movezz_sec.actor_keys SET is_active = false, retired_at = now() WHERE id = p_id AND is_active
$$;

-- Assertions are valid for at most 5 minutes, so session rows older than a week can be pruned without enabling replay.
CREATE FUNCTION movezz_sec.prune_actor_sessions(p_older interval DEFAULT interval '7 days') RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM movezz_sec.actor_sessions WHERE created_at < now() - p_older;  -- housekeeping of spent assertions only; no business data
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ============================== 4. begin_actor: verify and record the actor for THIS transaction =====================
CREATE FUNCTION movezz_sec.begin_actor(p_type text, p_user uuid, p_request_id text, p_jti text, p_exp bigint, p_sig text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_now  double precision := extract(epoch FROM clock_timestamp());
  v_xid  xid8 := pg_current_xact_id();
  v_msg  bytea;
  v_ok   boolean := false;
  k      record;
  u_role text;
  u_customer uuid;
  u_active boolean;
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('user','system','integration','import')
     OR (p_type = 'user') <> (p_user IS NOT NULL)
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_jti IS NULL OR p_jti !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_sig IS NULL OR p_sig !~ '^[0-9a-f]{64}$'
     OR p_exp IS NULL OR p_exp < v_now OR p_exp > v_now + 300 THEN
    RAISE EXCEPTION 'invalid actor assertion' USING ERRCODE = 'MV007';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM movezz_sec.actor_keys WHERE is_active) THEN
    RAISE EXCEPTION 'actor keys are not configured' USING ERRCODE = 'MV007';
  END IF;

  v_msg := movezz_sec.assertion_message(p_type, p_user, p_request_id, p_jti, p_exp);
  FOR k IN SELECT key FROM movezz_sec.actor_keys WHERE is_active LOOP        -- no early exit
    -- compare digests of the two MACs so a mismatch leaks no prefix information
    IF sha256(movezz_sec.hmac_sha256(k.key, v_msg)) = sha256(decode(p_sig, 'hex')) THEN v_ok := true; END IF;
  END LOOP;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'invalid actor assertion' USING ERRCODE = 'MV007';
  END IF;

  IF EXISTS (SELECT 1 FROM movezz_sec.actor_sessions WHERE txid = v_xid) THEN
    RAISE EXCEPTION 'an actor is already established for this transaction' USING ERRCODE = 'MV007';
  END IF;

  IF p_type = 'user' THEN
    -- role and customer link come from the database only; FOR SHARE keeps a concurrent deactivation from slipping past
    SELECT role, is_active, customer_id INTO u_role, u_active, u_customer FROM public.users WHERE id = p_user FOR SHARE;
    IF NOT FOUND OR NOT u_active THEN
      RAISE EXCEPTION 'actor does not exist or is inactive' USING ERRCODE = 'MV007';
    END IF;
    IF u_customer IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.customers c WHERE c.id = u_customer AND (c.status <> 'active' OR c.archived_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'the actor''s customer is inactive' USING ERRCODE = 'MV007';
    END IF;
  END IF;

  BEGIN
    INSERT INTO movezz_sec.actor_sessions (txid, jti, actor_type, user_id, role, customer_id, request_id)
    VALUES (v_xid, p_jti, p_type, p_user, u_role, u_customer, p_request_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'actor assertion was already used' USING ERRCODE = 'MV007';
  END;
END $$;

-- ============================== 5. read accessors (scalar results only) ==============================================
CREATE FUNCTION movezz_sec.current_actor_id() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v uuid;
BEGIN
  SELECT s.user_id INTO v FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned();
  RETURN v;
END $$;

CREATE FUNCTION movezz_sec.current_actor_type() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text;
BEGIN
  SELECT s.actor_type INTO v FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned();
  RETURN v;
END $$;

-- Fails closed. Returns the user id (NULL for service actors: system / integration / import).
CREATE FUNCTION movezz_sec.require_actor() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s movezz_sec.actor_sessions;
BEGIN
  SELECT * INTO s FROM movezz_sec.actor_sessions x WHERE x.txid = pg_current_xact_id_if_assigned();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an authenticated actor is required for this operation' USING ERRCODE = 'MV007';
  END IF;
  RETURN s.user_id;
END $$;

-- ============================== 6. the ONLY ways to write audit / status history ======================================
-- Neither function takes an actor argument: the actor is whatever begin_actor verified for this transaction.
CREATE FUNCTION movezz_sec.append_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb,
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
  INSERT INTO public.audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data, request_id, ip_address, user_agent)
  VALUES (s.user_id, s.actor_type, p_action, p_entity_type, p_entity_id, p_before, p_after, s.request_id, p_ip, p_user_agent)
  RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION movezz_sec.append_status_event(p_entity_type text, p_entity_id uuid, p_old text, p_new text,
                                               p_reason text DEFAULT NULL, p_metadata jsonb DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s movezz_sec.actor_sessions; v bigint;
BEGIN
  SELECT * INTO s FROM movezz_sec.actor_sessions x WHERE x.txid = pg_current_xact_id_if_assigned();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an authenticated actor is required to write a status event' USING ERRCODE = 'MV007';
  END IF;
  INSERT INTO public.status_events (entity_type, entity_id, old_status, new_status, actor_user_id, actor_type, reason, metadata)
  VALUES (p_entity_type, p_entity_id, p_old, p_new, s.user_id, s.actor_type, p_reason, p_metadata)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- For database triggers only (NOT executable by the runtime role): attributes the event to the verified actor when there
-- is one, otherwise to 'system'. This is how a payment that settles an invoice records the invoice status change.
CREATE FUNCTION movezz_sec.append_status_event_internal(p_entity_type text, p_entity_id uuid, p_old text, p_new text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s movezz_sec.actor_sessions;
BEGIN
  SELECT * INTO s FROM movezz_sec.actor_sessions x WHERE x.txid = pg_current_xact_id_if_assigned();
  INSERT INTO public.status_events (entity_type, entity_id, old_status, new_status, actor_user_id, actor_type, reason)
  VALUES (p_entity_type, p_entity_id, p_old, p_new, s.user_id, coalesce(s.actor_type, 'system'), p_reason);
END $$;

-- Defence in depth: whoever inserts (even the owner), a 'user' row must name exactly the verified actor of this
-- transaction; non-user rows carry no user id. Existing rows are not re-checked (history is never rewritten).
CREATE FUNCTION movezz_sec.actor_columns_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF NEW.actor_type = 'user' THEN
    SELECT s.user_id INTO v FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned();
    IF NEW.actor_user_id IS NULL OR v IS DISTINCT FROM NEW.actor_user_id THEN
      RAISE EXCEPTION 'record actor does not match the verified actor of this transaction' USING ERRCODE = 'MV007';
    END IF;
  ELSIF NEW.actor_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-user actors cannot carry a user id' USING ERRCODE = 'MV007';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_logs_actor_guard   BEFORE INSERT ON public.audit_logs    FOR EACH ROW EXECUTE FUNCTION movezz_sec.actor_columns_guard();
CREATE TRIGGER status_events_actor_guard BEFORE INSERT ON public.status_events FOR EACH ROW EXECUTE FUNCTION movezz_sec.actor_columns_guard();
ALTER TABLE public.audit_logs    ADD CONSTRAINT audit_logs_actor_kind_chk    CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)) NOT VALID;
ALTER TABLE public.status_events ADD CONSTRAINT status_events_actor_kind_chk CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)) NOT VALID;

-- No function in the private schema is callable by PUBLIC; the runtime role gets an explicit allow-list below.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA movezz_sec FROM PUBLIC;

-- ============================== 7. attribution columns are stamped from the verified actor ===========================
-- created_by / voided_by / cancelled_by used to be whatever the caller wrote. They are now taken from the verified
-- actor; a caller-supplied value that differs is rejected, and the operation fails without an established actor.
CREATE OR REPLACE FUNCTION payments_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_inv invoices; v_paid numeric(14,2); v_actor uuid := movezz_sec.require_actor();
BEGIN
  IF NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'created_by does not match the verified actor' USING ERRCODE = 'MV007';
  END IF;
  NEW.created_by := v_actor;
  SELECT * INTO v_inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice does not exist' USING ERRCODE = 'MV005';
  END IF;
  IF v_inv.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Invoice % is cancelled; payments are not accepted', v_inv.invoice_ref USING ERRCODE = 'MV005';
  END IF;
  IF NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'Payments are created as completed and voided later' USING ERRCODE = 'MV005';
  END IF;
  SELECT coalesce(sum(amount_ghs), 0) INTO v_paid FROM payments WHERE invoice_id = NEW.invoice_id AND status = 'completed';
  IF v_paid + NEW.amount_ghs > v_inv.total_ghs THEN
    RAISE EXCEPTION 'Payment of GHS % exceeds the balance due of GHS % on %', NEW.amount_ghs, v_inv.total_ghs - v_paid, v_inv.invoice_ref
      USING ERRCODE = 'MV003';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payments_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := movezz_sec.require_actor();
BEGIN
  IF OLD.status <> 'completed' OR NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'A payment can only be voided (completed -> voided)' USING ERRCODE = 'MV005';
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount_ghs IS DISTINCT FROM OLD.amount_ghs
     OR NEW.usd_equivalent IS DISTINCT FROM OLD.usd_equivalent OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
     OR NEW.keepup_reference IS DISTINCT FROM OLD.keepup_reference OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.legacy_airtable_id IS DISTINCT FROM OLD.legacy_airtable_id THEN
    RAISE EXCEPTION 'Payments are immutable; only voiding is allowed' USING ERRCODE = 'MV004';
  END IF;
  IF NEW.voided_by IS NOT NULL AND NEW.voided_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'voided_by does not match the verified actor' USING ERRCODE = 'MV007';
  END IF;
  NEW.voided_by := v_actor;
  PERFORM 1 FROM invoices WHERE id = OLD.invoice_id FOR UPDATE;
  RETURN NEW;
END $$;

CREATE FUNCTION invoices_actor_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_actor := movezz_sec.require_actor();
    IF NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'created_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.created_by := v_actor;
  ELSIF OLD.status <> 'Cancelled' AND NEW.status = 'Cancelled' THEN
    v_actor := movezz_sec.require_actor();
    IF NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'cancelled_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.cancelled_by := v_actor;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_actor_stamp BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_actor_stamp();

CREATE FUNCTION idempotency_actor_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor uuid := movezz_sec.require_actor();
BEGIN
  IF NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'idempotency actor does not match the verified actor' USING ERRCODE = 'MV007';
  END IF;
  NEW.actor_user_id := v_actor;
  RETURN NEW;
END $$;
CREATE TRIGGER idempotency_actor_stamp BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION idempotency_actor_stamp();

-- ============================== 8. trigger-written status events no longer need INSERT on status_events ==============
-- These three run as the schema owner (fixed, parameter-free logic; strict search_path; fully qualified names) and are
-- not executable by PUBLIC. Trigger functions are not EXECUTE-checked when they fire, only when the trigger is created.
CREATE OR REPLACE FUNCTION recompute_invoice_payments(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_inv  public.invoices;
  v_paid numeric(14,2);
  v_new  text;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id;
  SELECT coalesce(sum(amount_ghs), 0) INTO v_paid FROM public.payments WHERE invoice_id = p_invoice_id AND status = 'completed';
  v_new := CASE
    WHEN v_inv.status = 'Cancelled' THEN 'Cancelled'
    WHEN v_inv.total_ghs = 0 THEN 'Paid'
    WHEN v_paid > 0 AND v_paid >= v_inv.total_ghs THEN 'Paid'
    WHEN v_paid > 0 THEN 'Partial'
    ELSE 'Pending'
  END;
  UPDATE public.invoices SET amount_paid_ghs = v_paid, status = v_new WHERE id = p_invoice_id;
  IF v_new IS DISTINCT FROM v_inv.status THEN
    PERFORM movezz_sec.append_status_event_internal('invoice', p_invoice_id, v_inv.status, v_new, 'payment ledger changed');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION payments_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.recompute_invoice_payments(NEW.invoice_id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION customers_deactivate_logins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  IF (OLD.status = 'active' AND OLD.archived_at IS NULL) AND (NEW.status <> 'active' OR NEW.archived_at IS NOT NULL) THEN
    FOR r IN UPDATE public.users SET is_active = false, deactivated_at = now() WHERE customer_id = NEW.id AND is_active RETURNING id
    LOOP
      PERFORM movezz_sec.append_status_event_internal('user', r.id, 'active', 'inactive', 'customer deactivated or archived');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION recompute_invoice_payments(uuid), payments_after_change(), customers_deactivate_logins() FROM PUBLIC;

-- ============================== 9. pin search_path everywhere, close the temp-table / public-schema hijack ===========
-- An invoker trigger that names "payments" unqualified would resolve a pg_temp.payments table created by the runtime
-- role BEFORE the real one (pg_temp is searched first by default). Fix both ways: withdraw TEMP/CREATE, and pin every
-- public function's search_path with pg_temp LAST.
ALTER FUNCTION allocate_reference(text, text)            SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION allocate_container_reference(integer)     SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION seed_reference_counter(text, text, bigint) SET search_path = pg_catalog, public, pg_temp;
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f.sig);
  END LOOP;
  BEGIN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not revoke CREATE on schema public / TEMPORARY on the database (not the owner); do it as the database owner';
  END;
END $$;

-- ============================== 10. runtime grants, replaced ========================================================
CREATE OR REPLACE FUNCTION apply_runtime_grants(p_role text DEFAULT 'movezz_app') RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE NOTICE 'role % does not exist; grants skipped', p_role;
    RETURN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  FOREACH t IN ARRAY ARRAY['warehouses','suppliers','package_rates','customers','users','registration_requests','special_rates',
                           'containers','invoices','cartons','items','item_photos','payments','keepup_sync']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, p_role);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoice_lines','fx_rates']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, p_role);
  END LOOP;
  -- history: READ ONLY. It is written exclusively through movezz_sec.append_audit / append_status_event.
  FOREACH t IN ARRAY ARRAY['status_events','audit_logs']
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, p_role);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('GRANT UPDATE (is_active) ON fx_rates TO %I', p_role);
  FOREACH t IN ARRAY ARRAY['idempotency_keys','notification_outbox']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('REVOKE ALL ON reference_counters FROM %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION allocate_reference(text, text), allocate_container_reference(integer) TO %I', p_role);
  EXECUTE format('GRANT SELECT ON active_customers TO %I', p_role);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', p_role);

  -- the actor mechanism: USAGE on the private schema + EXECUTE on an explicit allow-list; no table privileges at all
  EXECUTE format('GRANT USAGE ON SCHEMA movezz_sec TO %I', p_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA movezz_sec FROM %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION movezz_sec.begin_actor(text, uuid, text, text, bigint, text), movezz_sec.current_actor_id(),
                  movezz_sec.current_actor_type(), movezz_sec.require_actor(),
                  movezz_sec.append_audit(text, text, text, jsonb, jsonb, inet, text),
                  movezz_sec.append_status_event(text, uuid, text, text, text, jsonb) TO %I', p_role);
  -- no temporary tables, no objects in public
  BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), p_role);
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', p_role);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not revoke TEMPORARY/CREATE (not the owner)';
  END;
END $$;
REVOKE ALL ON FUNCTION apply_runtime_grants(text) FROM PUBLIC;
SELECT apply_runtime_grants('movezz_app');
