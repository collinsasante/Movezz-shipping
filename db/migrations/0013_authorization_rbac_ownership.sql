-- 0013_authorization_rbac_ownership: database enforcement of the Phase 7F authorization model.
--
-- The application decides authorization with the verified actor (0010) and the role/customer link that begin_actor read from
-- `users` for THIS transaction. This migration makes PostgreSQL enforce the same rules, so a service that forgot a check, or SQL
-- run through the runtime role, still cannot cross the boundary:
--   1. users: the runtime role can no longer write any user column except last_login_at. User administration is a set of
--      SECURITY DEFINER functions that require a super_admin actor, never touch super_admins, never act on oneself, and audit.
--      The last active super_admin can never be deactivated, demoted or deleted by anyone (trigger, applies to the owner too).
--   2. Rates, FX, warehouses, suppliers: writes through the runtime role require a super_admin actor.
--   3. customers: identity/configuration only by super_admin; a customer may change ONLY notes and shipping_address of THEIR row.
--   4. Financial writes: invoices (native), payments and keepup_sync need super_admin (keepup: or the integration/system service identity).
--   5. Customers can never write operational tables; with a customer actor, row-level security limits every read to their own rows.
--   6. Cancelling an invoice is super_admin only (tightens 0012, which allowed warehouse staff).
-- "Operator" paths (the table owner / superusers: migrations, imports, ops) are not subject to the actor rules; the runtime role is.
-- No drops of tables/columns, no data rewrites. Existing rows are not re-validated (history is never rewritten).

-- ============================== helpers ===============================================================================
-- p_role must be the CALLER's role (trigger functions pass current_user): inside a SECURITY DEFINER function current_user is the owner.
CREATE FUNCTION movezz_sec.is_operator(p_relid oid, p_role name) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = p_role AND r.rolsuper)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = p_relid AND pg_catalog.pg_get_userbyid(c.relowner) = p_role)
$$;
REVOKE ALL ON FUNCTION movezz_sec.is_operator(oid, name) FROM PUBLIC;

CREATE FUNCTION movezz_sec.actor_customer_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v uuid;
BEGIN
  SELECT s.customer_id INTO v FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned() AND s.actor_type = 'user';
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.actor_customer_id() FROM PUBLIC;

CREATE FUNCTION movezz_sec.actor_context() RETURNS TABLE (actor_type text, user_id uuid, role text, customer_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT s.actor_type, s.user_id, s.role, s.customer_id FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned();
END $$;
REVOKE ALL ON FUNCTION movezz_sec.actor_context() FROM PUBLIC;

-- does the entity named by a status_events row belong to the actor's customer? (used by row-level security)
CREATE FUNCTION movezz_sec.actor_owns_entity(p_type text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'item'    THEN EXISTS (SELECT 1 FROM public.items    x WHERE x.id = p_id AND x.customer_id = movezz_sec.actor_customer_id())
    WHEN 'carton'  THEN EXISTS (SELECT 1 FROM public.cartons  x WHERE x.id = p_id AND x.customer_id = movezz_sec.actor_customer_id())
    WHEN 'invoice' THEN EXISTS (SELECT 1 FROM public.invoices x WHERE x.id = p_id AND x.customer_id = movezz_sec.actor_customer_id())
    WHEN 'payment' THEN EXISTS (SELECT 1 FROM public.payments p JOIN public.invoices i ON i.id = p.invoice_id
                                 WHERE p.id = p_id AND i.customer_id = movezz_sec.actor_customer_id())
    ELSE false END
$$;
REVOKE ALL ON FUNCTION movezz_sec.actor_owns_entity(text, uuid) FROM PUBLIC;

-- ============================== 2. administration-only tables =========================================================
CREATE FUNCTION movezz_sec.admin_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION '% is administered by a super_admin only', TG_TABLE_NAME USING ERRCODE = 'MV012';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION movezz_sec.admin_only_guard() FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['package_rates','special_rates','fx_rates','warehouses','suppliers'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION movezz_sec.admin_only_guard()', t || '_admin_only', t);
  END LOOP;
END $$;

-- ============================== 3. customers ==========================================================================
CREATE FUNCTION movezz_sec.customers_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_role text := movezz_sec.actor_role();
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP <> 'UPDATE' THEN
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Only a super_admin may create customers' USING ERRCODE = 'MV012';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_role = 'super_admin' THEN RETURN NEW; END IF;
  IF v_role = 'customer' AND OLD.id = movezz_sec.actor_customer_id() THEN
    -- a customer may change ONLY these two columns of their own record (D7); everything else is an administrative operation
    -- phone_digits is generated from phone and not yet computed inside a BEFORE trigger, so it is excluded from the comparison
    IF (to_jsonb(NEW) - 'notes' - 'shipping_address' - 'updated_at' - 'phone_digits') IS DISTINCT FROM (to_jsonb(OLD) - 'notes' - 'shipping_address' - 'updated_at' - 'phone_digits') THEN
      RAISE EXCEPTION 'Customers may change only their address and notes' USING ERRCODE = 'MV012';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Customer records are administered by a super_admin' USING ERRCODE = 'MV012';
END $$;
REVOKE ALL ON FUNCTION movezz_sec.customers_authority() FROM PUBLIC;
CREATE TRIGGER customers_authority BEFORE INSERT OR UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION movezz_sec.customers_authority();

-- ============================== 1. users ==============================================================================
CREATE FUNCTION movezz_sec.users_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.auth_uid IS DISTINCT FROM OLD.auth_uid THEN
    RAISE EXCEPTION 'The authentication identity of a user cannot be changed' USING ERRCODE = 'MV004';
  END IF;
  -- the last active super_admin can never be removed, demoted or deactivated (not even by the owner): bootstrap a second one first
  IF OLD.role = 'super_admin' AND OLD.is_active
     AND (TG_OP = 'DELETE' OR NEW.role <> 'super_admin' OR NOT NEW.is_active)
     AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.role = 'super_admin' AND u.is_active AND u.id <> OLD.id) THEN
    RAISE EXCEPTION 'The last active super_admin cannot be removed, demoted or deactivated' USING ERRCODE = 'MV005';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION movezz_sec.users_guard() FROM PUBLIC;
CREATE TRIGGER users_guard BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION movezz_sec.users_guard();

-- User administration. Each function: verified super_admin actor; never grants/changes/removes super_admin (bootstrap only, D9);
-- never acts on the caller's own account; audited with the verified actor.
CREATE FUNCTION movezz_sec.admin_create_user(p_auth_uid text, p_email text, p_full_name text, p_role text, p_customer_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Only a super_admin may create users' USING ERRCODE = 'MV012'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('warehouse_staff', 'customer') THEN
    RAISE EXCEPTION 'A super_admin can only be created by the bootstrap procedure; allowed roles here: warehouse_staff, customer' USING ERRCODE = 'MV012';
  END IF;
  IF p_role = 'customer' AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.status = 'active' AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'A customer login must be linked to an existing active customer' USING ERRCODE = 'MV006';
  END IF;
  IF p_role = 'warehouse_staff' AND p_customer_id IS NOT NULL THEN RAISE EXCEPTION 'Staff logins cannot be linked to a customer' USING ERRCODE = 'MV006'; END IF;
  INSERT INTO public.users (auth_uid, email, full_name, role, customer_id) VALUES (p_auth_uid, p_email, p_full_name, p_role, p_customer_id) RETURNING id INTO v_id;
  PERFORM movezz_sec.append_audit('user.create', 'user', v_id::text, NULL,
          jsonb_build_object('role', p_role, 'customer_id', p_customer_id, 'email', p_email));
  RETURN v_id;
END $$;

CREATE FUNCTION movezz_sec.admin_set_user_role(p_user uuid, p_role text, p_customer_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t public.users;
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Only a super_admin may change roles' USING ERRCODE = 'MV012'; END IF;
  IF p_user = movezz_sec.current_actor_id() THEN RAISE EXCEPTION 'You cannot change your own role or customer link' USING ERRCODE = 'MV012'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('warehouse_staff', 'customer') THEN RAISE EXCEPTION 'super_admin cannot be granted here' USING ERRCODE = 'MV012'; END IF;
  SELECT * INTO t FROM public.users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found' USING ERRCODE = 'MV006'; END IF;
  IF t.role = 'super_admin' THEN RAISE EXCEPTION 'A super_admin account cannot be modified here' USING ERRCODE = 'MV012'; END IF;
  IF p_role = 'customer' AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.status = 'active' AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'A customer login must be linked to an existing active customer' USING ERRCODE = 'MV006';
  END IF;
  IF p_role = 'warehouse_staff' AND p_customer_id IS NOT NULL THEN RAISE EXCEPTION 'Staff logins cannot be linked to a customer' USING ERRCODE = 'MV006'; END IF;
  UPDATE public.users SET role = p_role, customer_id = CASE WHEN p_role = 'customer' THEN p_customer_id END WHERE id = p_user;
  PERFORM movezz_sec.append_audit('user.role_change', 'user', p_user::text,
          jsonb_build_object('role', t.role, 'customer_id', t.customer_id), jsonb_build_object('role', p_role, 'customer_id', p_customer_id));
END $$;

CREATE FUNCTION movezz_sec.admin_set_user_active(p_user uuid, p_active boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t public.users;
BEGIN
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Only a super_admin may activate or deactivate users' USING ERRCODE = 'MV012'; END IF;
  IF p_user = movezz_sec.current_actor_id() THEN RAISE EXCEPTION 'You cannot change your own account state' USING ERRCODE = 'MV012'; END IF;
  IF p_active IS NULL THEN RAISE EXCEPTION 'p_active is required' USING ERRCODE = 'MV006'; END IF;
  SELECT * INTO t FROM public.users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found' USING ERRCODE = 'MV006'; END IF;
  IF t.role = 'super_admin' THEN RAISE EXCEPTION 'A super_admin account cannot be modified here' USING ERRCODE = 'MV012'; END IF;
  IF p_active AND t.customer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.customers c WHERE c.id = t.customer_id AND c.status = 'active' AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'The linked customer is inactive; reactivate the customer first' USING ERRCODE = 'MV005';
  END IF;
  UPDATE public.users SET is_active = p_active, deactivated_at = CASE WHEN p_active THEN NULL ELSE now() END WHERE id = p_user;
  PERFORM movezz_sec.append_audit(CASE WHEN p_active THEN 'user.activate' ELSE 'user.deactivate' END, 'user', p_user::text,
          jsonb_build_object('is_active', t.is_active), jsonb_build_object('is_active', p_active, 'reason', p_reason));
END $$;
REVOKE ALL ON FUNCTION movezz_sec.admin_create_user(text, text, text, text, uuid), movezz_sec.admin_set_user_role(uuid, text, uuid),
                       movezz_sec.admin_set_user_active(uuid, boolean, text) FROM PUBLIC;

-- ============================== 4. financial writes ===================================================================
CREATE FUNCTION movezz_sec.financial_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_type text := movezz_sec.current_actor_type();
BEGIN
  IF movezz_sec.is_operator(TG_RELID, current_user) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'keepup_sync' THEN
    -- manual Keepup actions are super_admin only (A4); the automated worker runs under its own service identity
    IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' AND v_type IS DISTINCT FROM 'integration' AND v_type IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'Keepup synchronization state is changed by a super_admin or the integration service only' USING ERRCODE = 'MV012';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.provenance <> 'native' THEN RETURN NEW; END IF;   -- historical rows: guarded by invoices_pricing_authority (import actor only)
  END IF;
  IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION '% records are created and corrected by a super_admin only', TG_TABLE_NAME USING ERRCODE = 'MV012';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION movezz_sec.financial_authority() FROM PUBLIC;
-- names sort AFTER the 0010/0011 triggers on purpose, so their more specific errors (MV007 / MV008 / MV011) still come first
CREATE TRIGGER invoices_role_authority BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION movezz_sec.financial_authority();
CREATE TRIGGER zz_payments_role_authority BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION movezz_sec.financial_authority();
CREATE TRIGGER keepup_sync_role_authority BEFORE INSERT OR UPDATE ON keepup_sync FOR EACH ROW EXECUTE FUNCTION movezz_sec.financial_authority();

-- cancelling an invoice: super_admin only (0012 allowed warehouse staff too)
CREATE OR REPLACE FUNCTION invoices_actor_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Only a super_admin may cancel an invoice' USING ERRCODE = 'MV012';
    END IF;
    IF NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'cancelled_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.cancelled_by := v_actor;
  END IF;
  RETURN NEW;
END $$;

-- ============================== 5. customers never write operational data; row-level security for customer actors =======
CREATE FUNCTION movezz_sec.no_customer_writes() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF movezz_sec.actor_role() = 'customer' THEN
    RAISE EXCEPTION 'Customers cannot modify % records', TG_TABLE_NAME USING ERRCODE = 'MV012';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION movezz_sec.no_customer_writes() FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['items','cartons','containers','item_photos','invoice_lines','invoices','notification_outbox','registration_requests','idempotency_keys'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION movezz_sec.no_customer_writes()', 'zz_' || t || '_no_customer_writes', t);
  END LOOP;
END $$;

-- Row-level security. It binds the RUNTIME role (the owner bypasses it) and only changes anything when the transaction's verified
-- actor is a customer: that actor sees its own rows and nothing else. Staff, admins, service actors and no-actor sessions are
-- unaffected here (their access is decided by the grants, guards and services above).
DO $$
DECLARE
  t text;
  own text := 'movezz_sec.actor_role() IS DISTINCT FROM ''customer'' OR customer_id = movezz_sec.actor_customer_id()';
BEGIN
  FOREACH t IN ARRAY ARRAY['items','cartons','invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY customer_scope ON %I USING (%s) WITH CHECK (%s)', t, own, own);
  END LOOP;
END $$;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON customers USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer' OR id = movezz_sec.actor_customer_id())
  WITH CHECK (movezz_sec.actor_role() IS DISTINCT FROM 'customer' OR id = movezz_sec.actor_customer_id());
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON users USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer' OR id = movezz_sec.current_actor_id());
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON invoice_lines USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer'
  OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id AND i.customer_id = movezz_sec.actor_customer_id()));
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON payments USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer'
  OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = payments.invoice_id AND i.customer_id = movezz_sec.actor_customer_id()));
ALTER TABLE item_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON item_photos USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer'
  OR EXISTS (SELECT 1 FROM items i WHERE i.id = item_photos.item_id AND i.customer_id = movezz_sec.actor_customer_id()));
ALTER TABLE status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON status_events USING (movezz_sec.actor_role() IS DISTINCT FROM 'customer' OR movezz_sec.actor_owns_entity(entity_type, entity_id));
-- tables a customer actor must not read at all
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_logs','keepup_sync','notification_outbox','idempotency_keys','containers','suppliers','special_rates','registration_requests','fx_rates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY no_customer_access ON %I USING (movezz_sec.actor_role() IS DISTINCT FROM ''customer'')', t);
  END LOOP;
END $$;

-- ============================== runtime grants ========================================================================
CREATE OR REPLACE FUNCTION apply_runtime_grants(p_role text DEFAULT 'movezz_app') RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE NOTICE 'role % does not exist; grants skipped', p_role;
    RETURN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  FOREACH t IN ARRAY ARRAY['warehouses','suppliers','package_rates','customers','registration_requests','special_rates',
                           'containers','invoices','cartons','items','item_photos','payments','keepup_sync']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, p_role);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoice_lines','fx_rates']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, p_role);
  END LOOP;
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
                  movezz_sec.admin_set_user_active(uuid, boolean, text) TO %I', p_role);
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
