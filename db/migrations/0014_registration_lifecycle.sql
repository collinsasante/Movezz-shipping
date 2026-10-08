-- 0014_registration_lifecycle: public registration request -> super_admin approval -> verified activation (Phase 7G, D9).
--
--   pending --approve--> approved --activate--> activated        pending --reject--> rejected (terminal, kept as history)
--
--   * submit_registration()   the ONLY way to create a request. Callable only under the server's `system` actor. Normalizes input,
--                            ignores (without saying so to the caller's client) anyone who already has an account/customer or an
--                            open request, throttles per client/email/global, audits.
--   * approve_registration() super_admin only. Creates the customer from the request's own data (a customer without a login),
--                            marks the request approved, queues an applicant notification. Idempotent: never a second customer.
--   * reject_registration()  super_admin only, reason required, request kept.
--   * activate_registration() `system` actor with a Firebase identity the SERVER verified (uid + VERIFIED e-mail). Matches the
--                            approved request by that e-mail, creates the customer login (role 'customer', linked), marks the request
--                            activated, in ONE transaction. Idempotent for the same identity; never revives an inactive/archived customer.
--   * The runtime role can no longer INSERT/UPDATE registration_requests; SELECT is limited (RLS) to a super_admin actor.
-- Nothing here stores or handles a password. Existing rows are not rewritten; new constraints are NOT VALID (legacy-safe).

-- ============================== schema ================================================================================
ALTER TABLE registration_requests ADD COLUMN client_key text;             -- salted hash of the submitter's IP (throttling only; not the IP itself)
CREATE INDEX registration_client_key_idx ON registration_requests (client_key, created_at) WHERE client_key IS NOT NULL;
CREATE INDEX registration_email_created_idx ON registration_requests (lower(email), created_at);
ALTER TABLE registration_requests
  ADD CONSTRAINT registration_input_len_chk CHECK (length(name) <= 200 AND length(email) <= 254 AND length(coalesce(phone,'')) <= 30 AND length(coalesce(phone2,'')) <= 30
                                                   AND length(coalesce(existing_mark,'')) <= 100 AND length(coalesce(location,'')) <= 500 AND length(coalesce(notes,'')) <= 1000) NOT VALID;

-- reviewer / reviewed_at / resulting_* are written only by the lifecycle functions (which always set them; no CHECK, so legacy/imported
-- rows with no reviewer stay representable)
CREATE FUNCTION registration_normalize() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  NEW.name := btrim(regexp_replace(NEW.name, '\s+', ' ', 'g'));
  NEW.phone := nullif(btrim(regexp_replace(coalesce(NEW.phone, ''), '\s+', '', 'g')), '');
  NEW.phone2 := nullif(btrim(regexp_replace(coalesce(NEW.phone2, ''), '\s+', '', 'g')), '');
  NEW.existing_mark := nullif(btrim(coalesce(NEW.existing_mark, '')), '');
  NEW.location := nullif(btrim(coalesce(NEW.location, '')), '');
  NEW.notes := nullif(btrim(coalesce(NEW.notes, '')), '');
  RETURN NEW;
END $$;
CREATE TRIGGER registration_normalize BEFORE INSERT ON registration_requests FOR EACH ROW EXECUTE FUNCTION registration_normalize();

-- the lifecycle can never run backwards, whoever the caller is (also covers rows touched by the owner)
CREATE FUNCTION registration_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('rejected','activated','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Registration request is % and cannot be changed', OLD.status USING ERRCODE = 'MV005';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved' AND (NEW.resulting_customer_id IS DISTINCT FROM OLD.resulting_customer_id
       OR NEW.email IS DISTINCT FROM OLD.email OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'An approved registration cannot be re-bound to another customer, e-mail or reviewer' USING ERRCODE = 'MV005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registration_terminal_guard BEFORE UPDATE ON registration_requests FOR EACH ROW EXECUTE FUNCTION registration_terminal_guard();

-- row-level security: only a super_admin actor (or the owner / definer functions) can read registration data
DROP POLICY no_customer_access ON registration_requests;
CREATE POLICY admin_read ON registration_requests FOR SELECT USING (movezz_sec.actor_role() = 'super_admin');

-- ============================== helpers ===============================================================================
CREATE FUNCTION movezz_sec.next_shipping_mark(p_name text, p_phone text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w text[] := regexp_split_to_array(btrim(p_name), '\s+'); i1 text; i2 text; base text; cand text; n int := 1;
BEGIN
  i1 := coalesce(nullif(upper(substr(regexp_replace(coalesce(w[1], ''), '[^A-Za-z]', '', 'g'), 1, 1)), ''), 'X');
  i2 := coalesce(nullif(upper(substr(regexp_replace(coalesce(w[2], ''), '[^A-Za-z]', '', 'g'), 1, 1)), ''), 'X');
  base := 'MOVEZZ-' || i1 || i2 || right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 4);
  LOOP
    cand := CASE WHEN n = 1 THEN base ELSE base || '-' || n END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.shipping_mark = cand);
    n := n + 1;
    IF n > 99 THEN RAISE EXCEPTION 'Could not allocate a unique shipping mark' USING ERRCODE = 'MV006'; END IF;
  END LOOP;
  RETURN cand;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.next_shipping_mark(text, text) FROM PUBLIC;

-- ============================== 1. public submission ==================================================================
CREATE FUNCTION movezz_sec.submit_registration(p_name text, p_email text, p_phone text, p_phone2 text, p_existing_mark text,
                                               p_location text, p_notes text, p_client_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_email text := lower(btrim(coalesce(p_email, ''))); v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'); v_id uuid;
BEGIN
  IF movezz_sec.current_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'Registration requests are submitted by the server only' USING ERRCODE = 'MV012';
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 OR length(btrim(coalesce(p_name, ''))) < 2 OR length(p_name) > 200
     OR length(v_digits) < 7 OR length(coalesce(p_phone, '')) > 30 OR length(btrim(coalesce(p_location, ''))) < 2 OR length(p_location) > 500
     OR length(coalesce(p_phone2, '')) > 30 OR length(coalesce(p_existing_mark, '')) > 100 OR length(coalesce(p_notes, '')) > 1000 THEN
    RAISE EXCEPTION 'Invalid registration request' USING ERRCODE = 'MV006';
  END IF;

  -- throttling that does not depend on any one server instance (the route also has an in-memory limiter)
  IF p_client_key IS NOT NULL AND (SELECT count(*) FROM public.registration_requests r WHERE r.client_key = p_client_key AND r.created_at > now() - interval '1 hour') >= 5
     OR (SELECT count(*) FROM public.registration_requests r WHERE lower(r.email) = v_email AND r.created_at > now() - interval '1 day') >= 3
     OR (SELECT count(*) FROM public.registration_requests r WHERE r.created_at > now() - interval '1 hour') >= 300 THEN
    RAISE EXCEPTION 'Too many registration requests' USING ERRCODE = 'MV014';
  END IF;

  -- anyone who already has a login or a customer record (active, inactive or archived) is NOT told so and creates nothing:
  -- reviving or merging an existing account needs an explicit super_admin decision
  IF EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = v_email)
     OR EXISTS (SELECT 1 FROM public.customers c WHERE lower(c.email) = v_email OR (v_digits <> '' AND c.phone_digits = v_digits)) THEN
    PERFORM movezz_sec.append_audit('registration.ignored', 'registration_request', 'n/a', NULL, jsonb_build_object('reason', 'existing_account'));
    RETURN 'ignored';
  END IF;

  INSERT INTO public.registration_requests (email, name, phone, phone2, existing_mark, location, notes, client_key)
  VALUES (v_email, p_name, p_phone, p_phone2, p_existing_mark, p_location, p_notes, p_client_key)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;            -- the partial unique indexes (open e-mail / open phone) decide races
  IF v_id IS NULL THEN
    PERFORM movezz_sec.append_audit('registration.ignored', 'registration_request', 'n/a', NULL, jsonb_build_object('reason', 'open_request'));
    RETURN 'ignored';
  END IF;
  PERFORM movezz_sec.append_audit('registration.submit', 'registration_request', v_id::text, NULL, jsonb_build_object('status', 'pending'));
  RETURN 'received';
END $$;

-- ============================== 2. approval ===========================================================================
CREATE FUNCTION movezz_sec.approve_registration(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.registration_requests; v_customer uuid; v_mark text;
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Only a super_admin may approve a registration' USING ERRCODE = 'MV012'; END IF;
  SELECT * INTO r FROM public.registration_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration request not found' USING ERRCODE = 'MV013'; END IF;
  IF r.status = 'approved' THEN RETURN r.resulting_customer_id; END IF;                    -- idempotent: no second customer, no second audit
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Registration request is % and cannot be approved', r.status USING ERRCODE = 'MV005'; END IF;
  -- never silently merge with, or revive, an existing record
  IF EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = lower(r.email))
     OR EXISTS (SELECT 1 FROM public.customers c WHERE lower(c.email) = lower(r.email) OR (coalesce(r.phone_digits, '') <> '' AND c.phone_digits = r.phone_digits)) THEN
    RAISE EXCEPTION 'An account or customer with this e-mail or phone already exists; resolve it explicitly before approving' USING ERRCODE = 'MV015';
  END IF;
  v_mark := movezz_sec.next_shipping_mark(r.name, r.phone);
  INSERT INTO public.customers (name, phone, email, shipping_mark, shipping_address, notes, status, created_by)
  VALUES (r.name, r.phone, r.email, v_mark, r.location, r.notes, 'active', 'registration:' || r.id::text) RETURNING id INTO v_customer;
  UPDATE public.registration_requests SET status = 'approved', reviewed_by = movezz_sec.current_actor_id(), reviewed_at = now(), resulting_customer_id = v_customer WHERE id = p_id;
  INSERT INTO public.notification_outbox (event_type, channel, recipient, payload, dedupe_key)
  VALUES ('registration.approved', 'email', r.email, jsonb_build_object('registration_id', r.id), 'registration.approved:' || r.id::text) ON CONFLICT DO NOTHING;
  PERFORM movezz_sec.append_audit('registration.approve', 'registration_request', p_id::text, jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'approved', 'customer_id', v_customer, 'shipping_mark', v_mark));
  PERFORM movezz_sec.append_status_event_internal('registration_request', p_id, 'pending', 'approved', NULL);
  RETURN v_customer;
END $$;

-- ============================== 3. rejection ==========================================================================
CREATE FUNCTION movezz_sec.reject_registration(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r public.registration_requests;
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Only a super_admin may reject a registration' USING ERRCODE = 'MV012'; END IF;
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN RAISE EXCEPTION 'A rejection reason is required' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO r FROM public.registration_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration request not found' USING ERRCODE = 'MV013'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Registration request is % and cannot be rejected', r.status USING ERRCODE = 'MV005'; END IF;
  UPDATE public.registration_requests SET status = 'rejected', reviewed_by = movezz_sec.current_actor_id(), reviewed_at = now(), rejection_reason = p_reason WHERE id = p_id;
  PERFORM movezz_sec.append_audit('registration.reject', 'registration_request', p_id::text, jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'rejected', 'reason', p_reason));
  PERFORM movezz_sec.append_status_event_internal('registration_request', p_id, 'pending', 'rejected', p_reason);
END $$;

-- ============================== 4. activation =========================================================================
-- The caller is the server under a `system` actor, after it verified a Firebase ID token: p_auth_uid and p_email come from that
-- token, never from the client. Only a VERIFIED e-mail can activate.
CREATE FUNCTION movezz_sec.activate_registration(p_auth_uid text, p_email text, p_email_verified boolean)
RETURNS TABLE (user_id uuid, customer_id uuid, already_active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_email text := lower(btrim(coalesce(p_email, ''))); r public.registration_requests; c public.customers; v_user uuid; u public.users;
BEGIN
  IF movezz_sec.current_actor_type() IS DISTINCT FROM 'system' THEN RAISE EXCEPTION 'Activation is performed by the server only' USING ERRCODE = 'MV012'; END IF;
  IF p_auth_uid IS NULL OR btrim(p_auth_uid) = '' OR v_email = '' OR p_email_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'A verified identity is required' USING ERRCODE = 'MV013';
  END IF;
  SELECT * INTO r FROM public.registration_requests q WHERE lower(q.email) = v_email AND q.status IN ('approved','activated')
   ORDER BY q.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No approved registration for this identity' USING ERRCODE = 'MV013'; END IF;

  IF r.status = 'activated' THEN
    SELECT * INTO u FROM public.users x WHERE x.id = r.resulting_user_id;
    IF u.auth_uid = p_auth_uid THEN                                            -- retry by the same identity: same answer, no writes
      user_id := u.id; customer_id := u.customer_id; already_active := true; RETURN NEXT; RETURN;
    END IF;
    RAISE EXCEPTION 'No approved registration for this identity' USING ERRCODE = 'MV013';
  END IF;

  SELECT * INTO c FROM public.customers x WHERE x.id = r.resulting_customer_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'active' OR c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'The customer is not active; a super_admin must resolve this registration' USING ERRCODE = 'MV015';
  END IF;
  -- one Firebase identity = one Movezz user; one login per customer; e-mail unique: never adopt or revive an existing user
  IF EXISTS (SELECT 1 FROM public.users x WHERE x.auth_uid = p_auth_uid) OR EXISTS (SELECT 1 FROM public.users x WHERE lower(x.email) = v_email)
     OR EXISTS (SELECT 1 FROM public.users x WHERE x.customer_id = c.id) THEN
    RAISE EXCEPTION 'An account already exists for this identity or customer; a super_admin must resolve it' USING ERRCODE = 'MV015';
  END IF;

  INSERT INTO public.users (auth_uid, email, full_name, role, customer_id, is_active) VALUES (p_auth_uid, v_email, c.name, 'customer', c.id, true) RETURNING id INTO v_user;
  UPDATE public.registration_requests SET status = 'activated', activated_at = now(), resulting_user_id = v_user WHERE id = r.id;
  PERFORM movezz_sec.append_audit('registration.activate', 'registration_request', r.id::text, jsonb_build_object('status', 'approved'),
          jsonb_build_object('status', 'activated', 'user_id', v_user, 'customer_id', c.id, 'auth_uid', p_auth_uid));
  PERFORM movezz_sec.append_audit('user.create', 'user', v_user::text, NULL, jsonb_build_object('role', 'customer', 'customer_id', c.id, 'via', 'registration'));
  PERFORM movezz_sec.append_status_event_internal('registration_request', r.id, 'approved', 'activated', NULL);
  user_id := v_user; customer_id := c.id; already_active := false; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION movezz_sec.submit_registration(text, text, text, text, text, text, text, text), movezz_sec.approve_registration(uuid),
                       movezz_sec.reject_registration(uuid, text), movezz_sec.activate_registration(text, text, boolean) FROM PUBLIC;

-- ============================== runtime grants ========================================================================
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
  -- registrations: READ only (row-level security limits it to a super_admin actor). Every change goes through the definer
  -- functions submit/approve/reject/activate_registration, which enforce the lifecycle.
  EXECUTE format('REVOKE ALL ON registration_requests FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON registration_requests TO %I', p_role);
  -- identity: the runtime role may READ users, and may change only harmless profile columns. It can NOT create users or
  -- change role / customer link / active state / auth uid: pricing and discount authority read users.role (via the
  -- verified actor session), so that column must not be writable by the application's SQL role. (User/registration
  -- services that legitimately manage users arrive in later phases as SECURITY DEFINER functions.)
  EXECUTE format('REVOKE ALL ON users FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON users TO %I', p_role);
  EXECUTE format('GRANT UPDATE (last_login_at) ON users TO %I', p_role);
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
                  movezz_sec.append_status_event(text, uuid, text, text, text, jsonb), movezz_sec.actor_role(),
                  movezz_sec.actor_customer_id(), movezz_sec.actor_context(), movezz_sec.is_operator(oid, name), movezz_sec.actor_owns_entity(text, uuid),
                  movezz_sec.admin_create_user(text, text, text, text, uuid), movezz_sec.admin_set_user_role(uuid, text, uuid),
                  movezz_sec.admin_set_user_active(uuid, boolean, text),
                  movezz_sec.submit_registration(text, text, text, text, text, text, text, text), movezz_sec.approve_registration(uuid),
                  movezz_sec.reject_registration(uuid, text), movezz_sec.activate_registration(text, text, boolean) TO %I', p_role);
  -- pricing authority (read-only database functions the pricing service calls)
  EXECUTE format('GRANT EXECUTE ON FUNCTION item_authoritative_price(uuid, uuid), resolve_special_rate(uuid, uuid, timestamptz, text),
                  current_fx_rate(text, text, timestamptz) TO %I', p_role);
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
