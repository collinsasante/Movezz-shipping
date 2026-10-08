-- 0008_runtime_grants: least-privilege grants for the application runtime role.
-- The roles themselves are created by an operator (db/roles/create-roles.sql) because creating roles needs a
-- privileged account and passwords must never live in migrations. If the role does not exist yet this migration
-- is a no-op; run `npm run db:grants` (re-applies the same grants) after creating it.
--
--   movezz_migrator : owns the schema, runs migrations. NOT used by the running application.
--   movezz_app      : runtime. DML only; no DDL, no TRUNCATE, not a superuser, no BYPASSRLS.
--
-- Hard deletes are withheld on every table except short-lived operational ones: financial, customer, item and audit
-- history cannot be deleted by the runtime role even if application code tried (archive / void / cancel instead).

CREATE FUNCTION apply_runtime_grants(p_role text DEFAULT 'movezz_app') RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE NOTICE 'role % does not exist; grants skipped', p_role;
    RETURN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  -- read + insert + update (no delete)
  FOREACH t IN ARRAY ARRAY['warehouses','suppliers','package_rates','customers','users','registration_requests','special_rates',
                           'containers','invoices','cartons','items','item_photos','payments','keepup_sync','reference_counters']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, p_role);
  END LOOP;
  -- append-only: read + insert only
  FOREACH t IN ARRAY ARRAY['invoice_lines','status_events','audit_logs','fx_rates']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, p_role);
  END LOOP;
  -- fx_rates rows are corrected by deactivating them
  EXECUTE format('GRANT UPDATE (is_active) ON fx_rates TO %I', p_role);
  -- short-lived operational tables may be purged
  FOREACH t IN ARRAY ARRAY['idempotency_keys','notification_outbox']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, p_role);
  END LOOP;
  EXECUTE format('GRANT SELECT ON active_customers TO %I', p_role);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', p_role);
END $$;

SELECT apply_runtime_grants('movezz_app');
