-- 0009_phase7_business_constraints: database-level enforcement of the locked business rules (docs/DECISIONS.md D1-D25
-- + Addendum A). Forward-only: migrations 0001-0008 are not edited. Order inside this file:
--   A pre-flight  B container counter (D1)  C counter hardening  D zero-price rules (D5)  E special-rate rules (D10)
--   F discount reason (D16)  G provenance (D11)  H FX bounds (D12)  I zero-value invoices (D4/A2)
--   J registration activation (D9)  K user/customer state (D8)
--
-- Destructive-statement review. This file drops no table or column and contains no row deletion, truncation or data rewrite except one
-- UPDATE (G: marks invoices that already have fx_estimated=true as provenance 'estimated' - labelling only, no money
-- value changes). It does use DROP FUNCTION / DROP CONSTRAINT / DROP INDEX, each only to REPLACE an object with a
-- stricter or equivalent one inside this single transaction:
--   * resolve_special_rate(uuid,uuid,timestamptz)           -> replaced by a version that REQUIRES the freight context
--   * registration_requests_status_check                    -> widened by 'activated'
--   * keepup_sync_sync_state_check                          -> widened by 'not_required'
--   * registration_open_email_uidx / registration_open_phone_uidx -> recreated to also cover 'approved'
-- If any existing row would violate a new rule, section A aborts the whole migration with counts and changes nothing.

-- ============================== A. PRE-FLIGHT (read-only) ===========================================================
DO $$
DECLARE msgs text[] := '{}'; n bigint;
BEGIN
  SELECT count(*) INTO n FROM items WHERE tier_price_usd = 0 OR special_price_usd = 0 OR tier_rate_usd = 0 OR special_rate_usd = 0;
  IF n > 0 THEN msgs := msgs || format('items with a zero price or rate: %s', n); END IF;
  SELECT count(*) INTO n FROM cartons WHERE price_usd = 0 OR rate_usd = 0;
  IF n > 0 THEN msgs := msgs || format('cartons with a zero price or rate: %s', n); END IF;
  SELECT count(*) INTO n FROM package_rates WHERE rate_usd = 0;
  IF n > 0 THEN msgs := msgs || format('package_rates with a zero rate: %s', n); END IF;
  SELECT count(*) INTO n FROM invoice_lines WHERE unit_price_usd = 0 OR line_total_usd = 0 OR rate_usd = 0;
  IF n > 0 THEN msgs := msgs || format('invoice_lines with a zero price/total/rate: %s', n); END IF;
  SELECT count(*) INTO n FROM invoices WHERE subtotal_usd = 0;
  IF n > 0 THEN msgs := msgs || format('invoices with a zero subtotal: %s', n); END IF;
  SELECT count(*) INTO n FROM special_rates WHERE sea_rate_usd = 0 OR air_rate_usd = 0;
  IF n > 0 THEN msgs := msgs || format('special_rates with a zero sea/air rate: %s', n); END IF;
  SELECT count(*) INTO n FROM invoices WHERE discount_usd > 0;
  IF n > 0 THEN msgs := msgs || format('invoices with a discount but no stored reason: %s', n); END IF;
  SELECT count(*) INTO n FROM invoices WHERE total_ghs = 0 AND status NOT IN ('Paid','Cancelled');
  IF n > 0 THEN msgs := msgs || format('zero-total invoices that are not Paid/Cancelled: %s', n); END IF;
  SELECT count(*) INTO n FROM keepup_sync k JOIN invoices i ON i.id = k.invoice_id WHERE k.kind = 'invoice' AND i.total_ghs = 0;
  IF n > 0 THEN msgs := msgs || format('Keepup sync rows for zero-total invoices: %s', n); END IF;
  SELECT count(*) INTO n FROM fx_rates WHERE base_currency = 'USD' AND quote_currency = 'GHS' AND rate NOT BETWEEN 0.1 AND 1000;
  IF n > 0 THEN msgs := msgs || format('fx_rates outside 0.1-1000: %s', n); END IF;
  SELECT count(*) INTO n FROM invoices WHERE fx_rate NOT BETWEEN 0.1 AND 1000;
  IF n > 0 THEN msgs := msgs || format('invoices with an FX rate outside 0.1-1000: %s', n); END IF;
  SELECT count(*) INTO n FROM users u JOIN customers c ON c.id = u.customer_id
   WHERE u.is_active AND (c.status <> 'active' OR c.archived_at IS NOT NULL);
  IF n > 0 THEN msgs := msgs || format('active logins of inactive/archived customers: %s', n); END IF;
  IF array_length(msgs, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 0009 refused (nothing was changed). Existing rows violate the approved Phase 7 rules and need explicit remediation first: %',
      array_to_string(msgs, '; ') USING ERRCODE = 'MV006';
  END IF;
END $$;

-- ============================== B. D1: one global, monotonic container counter ======================================
-- Seed the global counter above every number ever issued: old per-year counter rows (left in place, never deleted) and
-- every container reference that already exists.
INSERT INTO reference_counters (ref_type, scope, last_value)
SELECT 'container', '', greatest(
         coalesce((SELECT max(last_value) FROM reference_counters WHERE ref_type = 'container'), 0),
         coalesce((SELECT max(substring(container_ref FROM '([0-9]+)$')::bigint) FROM containers
                    WHERE container_ref ~ '^PMX-CON-[0-9]{4}-[0-9]+$'), 0))
ON CONFLICT (ref_type, scope) DO UPDATE SET last_value = greatest(reference_counters.last_value, excluded.last_value), updated_at = now();
-- No new row may use a per-year container scope (NOT VALID: leftover legacy per-year rows are not re-checked).
ALTER TABLE reference_counters ADD CONSTRAINT reference_counters_container_global_chk CHECK (ref_type <> 'container' OR scope = '') NOT VALID;

-- ============================== C. Counter hardening ================================================================
CREATE OR REPLACE FUNCTION allocate_reference(p_type text, p_scope text DEFAULT '') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n bigint;
BEGIN
  IF p_type = 'container' THEN
    RAISE EXCEPTION 'container references use allocate_container_reference()' USING ERRCODE = 'MV006';
  END IF;
  IF coalesce(p_scope, '') <> '' THEN
    RAISE EXCEPTION 'only containers print a year; counters are global' USING ERRCODE = 'MV006';
  END IF;
  INSERT INTO reference_counters (ref_type, scope, last_value) VALUES (p_type, '', 1)
  ON CONFLICT (ref_type, scope) DO UPDATE SET last_value = reference_counters.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_n;
  RETURN format_reference(p_type, '', v_n);
END $$;

-- PMX-CON-<creation year>-<global sequence>. The year is printed, never part of the counter key.
CREATE FUNCTION allocate_container_reference(p_year integer DEFAULT extract(year FROM now())::integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n bigint; digits text;
BEGIN
  IF p_year NOT BETWEEN 2000 AND 2999 THEN
    RAISE EXCEPTION 'invalid container year %', p_year USING ERRCODE = 'MV006';
  END IF;
  INSERT INTO reference_counters (ref_type, scope, last_value) VALUES ('container', '', 1)
  ON CONFLICT (ref_type, scope) DO UPDATE SET last_value = reference_counters.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_n;
  digits := v_n::text;
  RETURN 'PMX-CON-' || p_year || '-' || repeat('0', greatest(3 - length(digits), 0)) || digits;
END $$;

-- Migration-time helper only (not callable by the runtime role). Containers always use the global counter.
CREATE OR REPLACE FUNCTION seed_reference_counter(p_type text, p_scope text, p_at_least bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO reference_counters (ref_type, scope, last_value) VALUES (p_type, '', p_at_least)
  ON CONFLICT (ref_type, scope) DO UPDATE
    SET last_value = greatest(reference_counters.last_value, excluded.last_value), updated_at = now();
$$;

REVOKE ALL ON FUNCTION allocate_reference(text, text), allocate_container_reference(integer),
                       seed_reference_counter(text, text, bigint), apply_runtime_grants(text) FROM PUBLIC;

-- Runtime grants, replaced: reference_counters is no longer directly readable/writable by the runtime role; it may only
-- call the allocation functions. (Everything else is unchanged from 0008.)
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
  FOREACH t IN ARRAY ARRAY['invoice_lines','status_events','audit_logs','fx_rates']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, p_role);
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
END $$;
REVOKE ALL ON FUNCTION apply_runtime_grants(text) FROM PUBLIC;
SELECT apply_runtime_grants('movezz_app');

-- ============================== D. D5: a zero price is a pricing failure ============================================
-- NULL still means "not priced yet" (and cannot be invoiced); 0.00 is never a valid price or rate. Additive: the older
-- ">= 0" checks stay and these stricter ones sit beside them.
ALTER TABLE items
  ADD CONSTRAINT items_tier_price_pos_chk    CHECK (tier_price_usd    IS NULL OR tier_price_usd    > 0),
  ADD CONSTRAINT items_tier_rate_pos_chk     CHECK (tier_rate_usd     IS NULL OR tier_rate_usd     > 0),
  ADD CONSTRAINT items_special_price_pos_chk CHECK (special_price_usd IS NULL OR special_price_usd > 0),
  ADD CONSTRAINT items_special_rate_pos_chk  CHECK (special_rate_usd  IS NULL OR special_rate_usd  > 0);
ALTER TABLE cartons
  ADD CONSTRAINT cartons_price_pos_chk CHECK (price_usd IS NULL OR price_usd > 0),
  ADD CONSTRAINT cartons_rate_pos_chk  CHECK (rate_usd  IS NULL OR rate_usd  > 0);
ALTER TABLE package_rates ADD CONSTRAINT package_rates_rate_pos_chk CHECK (rate_usd > 0);
ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_unit_pos_chk  CHECK (unit_price_usd > 0),
  ADD CONSTRAINT invoice_lines_total_pos_chk CHECK (line_total_usd > 0),
  ADD CONSTRAINT invoice_lines_rate_pos_chk  CHECK (rate_usd IS NULL OR rate_usd > 0);

-- ============================== E. D10: special-rate cards ==========================================================
-- A card states a rate only for the freight types it covers; "0" is not "not offered".
ALTER TABLE special_rates ALTER COLUMN sea_rate_usd DROP NOT NULL, ALTER COLUMN sea_rate_usd DROP DEFAULT,
                          ALTER COLUMN air_rate_usd DROP NOT NULL, ALTER COLUMN air_rate_usd DROP DEFAULT;
ALTER TABLE special_rates
  ADD CONSTRAINT special_rates_sea_pos_chk CHECK (sea_rate_usd IS NULL OR sea_rate_usd > 0),
  ADD CONSTRAINT special_rates_air_pos_chk CHECK (air_rate_usd IS NULL OR air_rate_usd > 0),
  ADD CONSTRAINT special_rates_has_rate_chk CHECK (sea_rate_usd IS NOT NULL OR air_rate_usd IS NOT NULL);

DROP FUNCTION resolve_special_rate(uuid, uuid, timestamptz);   -- replaced below by a version that requires the rate context
CREATE FUNCTION resolve_special_rate(p_rate_id uuid, p_customer_id uuid, p_at timestamptz, p_freight text)
RETURNS special_rates LANGUAGE plpgsql STABLE AS $$
DECLARE r special_rates;
BEGIN
  IF p_freight IS NULL OR p_freight NOT IN ('sea','air') THEN
    RAISE EXCEPTION 'A special rate can only be applied to an item with a freight type (sea or air)' USING ERRCODE = 'MV002';
  END IF;
  SELECT * INTO r FROM special_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Special rate does not exist' USING ERRCODE = 'MV002';
  END IF;
  IF NOT r.is_active THEN
    RAISE EXCEPTION 'Special rate "%" is inactive', r.name USING ERRCODE = 'MV002';
  END IF;
  IF r.effective_from > p_at THEN
    RAISE EXCEPTION 'Special rate "%" is not yet effective', r.name USING ERRCODE = 'MV002';
  END IF;
  IF r.effective_to IS NOT NULL AND r.effective_to <= p_at THEN
    RAISE EXCEPTION 'Special rate "%" has expired', r.name USING ERRCODE = 'MV002';
  END IF;
  IF r.customer_id IS NOT NULL AND r.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'Special rate "%" belongs to another customer', r.name USING ERRCODE = 'MV002';
  END IF;
  IF (p_freight = 'sea' AND r.sea_rate_usd IS NULL) OR (p_freight = 'air' AND r.air_rate_usd IS NULL) THEN
    RAISE EXCEPTION 'Special rate "%" has no % rate', r.name, p_freight USING ERRCODE = 'MV002';
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION items_special_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.special_rate_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.special_rate_id IS DISTINCT FROM OLD.special_rate_id
          OR NEW.freight_type IS DISTINCT FROM OLD.freight_type) THEN
    PERFORM resolve_special_rate(NEW.special_rate_id, NEW.customer_id, now(), NEW.freight_type);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER items_special_rate_guard ON items;
CREATE TRIGGER items_special_rate_guard BEFORE INSERT OR UPDATE OF special_rate_id, freight_type ON items
  FOR EACH ROW EXECUTE FUNCTION items_special_rate_guard();

-- ============================== F. D16: discount reason (only when discount > 0) ====================================
ALTER TABLE invoices ADD COLUMN discount_reason text;
-- "non-empty" means at least one non-whitespace character (btrim() alone would let tabs/newlines through)
ALTER TABLE invoices
  ADD CONSTRAINT invoices_discount_reason_text_chk CHECK (discount_reason IS NULL OR discount_reason ~ '\S'),
  ADD CONSTRAINT invoices_discount_reason_req_chk  CHECK (discount_usd = 0 OR discount_reason IS NOT NULL);

-- ============================== G. D11/D15: provenance and ambiguity marking ========================================
-- 'native' = created by Movezz. The others describe imported/reconstructed history; ambiguity must be explained.
ALTER TABLE invoices      ADD COLUMN provenance text NOT NULL DEFAULT 'native' CHECK (provenance IN ('native','legacy_known','legacy_ambiguous','reconstructed','estimated')),
                          ADD COLUMN provenance_note text;
ALTER TABLE invoice_lines ADD COLUMN provenance text NOT NULL DEFAULT 'native' CHECK (provenance IN ('native','legacy_known','legacy_ambiguous','reconstructed','estimated')),
                          ADD COLUMN provenance_note text;
ALTER TABLE items         ADD COLUMN provenance text NOT NULL DEFAULT 'native' CHECK (provenance IN ('native','legacy_known','legacy_ambiguous','reconstructed','estimated')),
                          ADD COLUMN provenance_note text;
ALTER TABLE special_rates ADD COLUMN provenance text NOT NULL DEFAULT 'native' CHECK (provenance IN ('native','legacy_known','legacy_ambiguous','reconstructed','estimated')),
                          ADD COLUMN provenance_note text;
-- Labelling only: invoices already flagged fx_estimated become provenance 'estimated' (no monetary value changes).
UPDATE invoices SET provenance = 'estimated', provenance_note = 'fx_estimated was set before provenance tracking existed' WHERE fx_estimated;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_fx_estimated_prov_chk CHECK (NOT fx_estimated OR provenance IN ('estimated','legacy_ambiguous')),
  ADD CONSTRAINT invoices_subtotal_pos_chk CHECK (subtotal_usd > 0 OR provenance <> 'native');
ALTER TABLE invoices      ADD CONSTRAINT invoices_prov_note_chk      CHECK (provenance NOT IN ('legacy_ambiguous','estimated') OR coalesce(provenance_note, '') ~ '\S');
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_prov_note_chk CHECK (provenance NOT IN ('legacy_ambiguous','estimated') OR coalesce(provenance_note, '') ~ '\S');
ALTER TABLE items         ADD CONSTRAINT items_prov_note_chk         CHECK (provenance NOT IN ('legacy_ambiguous','estimated') OR coalesce(provenance_note, '') ~ '\S');
ALTER TABLE special_rates ADD CONSTRAINT special_rates_prov_note_chk CHECK (provenance NOT IN ('legacy_ambiguous','estimated') OR coalesce(provenance_note, '') ~ '\S');

-- ============================== H. D12: FX bounds ===================================================================
ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_usd_ghs_bounds_chk
  CHECK (NOT (base_currency = 'USD' AND quote_currency = 'GHS') OR rate BETWEEN 0.1 AND 1000);
ALTER TABLE invoices ADD CONSTRAINT invoices_fx_bounds_chk CHECK (fx_rate BETWEEN 0.1 AND 1000);

-- ============================== I. D4 / Addendum A2: zero-value invoices ============================================
-- A zero-total invoice is settled (Paid) with NO payment row, and is Movezz-only (Keepup sync state 'not_required').
ALTER TABLE invoices ADD CONSTRAINT invoices_zero_total_settled_chk CHECK (total_ghs > 0 OR status IN ('Paid','Cancelled'));

CREATE FUNCTION invoices_zero_total_settle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.total_ghs = 0 AND NEW.status = 'Pending' THEN
    NEW.status := 'Paid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_zero_total_settle BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_zero_total_settle();

CREATE OR REPLACE FUNCTION recompute_invoice_payments(p_invoice_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_inv  invoices;
  v_paid numeric(14,2);
  v_new  text;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  SELECT coalesce(sum(amount_ghs), 0) INTO v_paid FROM payments WHERE invoice_id = p_invoice_id AND status = 'completed';
  v_new := CASE
    WHEN v_inv.status = 'Cancelled' THEN 'Cancelled'
    WHEN v_inv.total_ghs = 0 THEN 'Paid'                      -- zero-value invoice: settled without any payment
    WHEN v_paid > 0 AND v_paid >= v_inv.total_ghs THEN 'Paid'
    WHEN v_paid > 0 THEN 'Partial'
    ELSE 'Pending'
  END;
  UPDATE invoices SET amount_paid_ghs = v_paid, status = v_new WHERE id = p_invoice_id;
  IF v_new IS DISTINCT FROM v_inv.status THEN
    INSERT INTO status_events (entity_type, entity_id, old_status, new_status, actor_type, reason)
    VALUES ('invoice', p_invoice_id, v_inv.status, v_new, 'system', 'payment ledger changed');
  END IF;
END $$;

ALTER TABLE keepup_sync DROP CONSTRAINT keepup_sync_sync_state_check;      -- widened below
ALTER TABLE keepup_sync ADD CONSTRAINT keepup_sync_sync_state_check
  CHECK (sync_state IN ('pending','creating','synced','failed','needs_reconciliation','cancelled','not_required'));

CREATE FUNCTION keepup_sync_zero_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric;
BEGIN
  IF NEW.kind = 'invoice' THEN
    SELECT total_ghs INTO v_total FROM invoices WHERE id = NEW.invoice_id;
    IF v_total = 0 AND NEW.sync_state NOT IN ('not_required','cancelled') THEN
      RAISE EXCEPTION 'A zero-total invoice is Movezz-only: Keepup sync state must be not_required' USING ERRCODE = 'MV005';
    END IF;
    IF v_total > 0 AND NEW.sync_state = 'not_required' THEN
      RAISE EXCEPTION 'not_required is only valid for a zero-total invoice' USING ERRCODE = 'MV005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keepup_sync_zero_total_guard BEFORE INSERT OR UPDATE OF sync_state ON keepup_sync
  FOR EACH ROW EXECUTE FUNCTION keepup_sync_zero_total_guard();

-- Invoice guard (replaced): the reason, provenance and note join the frozen snapshot columns (D2).
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_active_payments integer;
BEGIN
  IF OLD.status = 'Cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Invoice % is cancelled and cannot be changed', OLD.invoice_ref USING ERRCODE = 'MV004';
  END IF;
  IF NEW.invoice_ref IS DISTINCT FROM OLD.invoice_ref
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.subtotal_usd IS DISTINCT FROM OLD.subtotal_usd
     OR NEW.discount_usd IS DISTINCT FROM OLD.discount_usd
     OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
     OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
     OR NEW.fx_rate_id IS DISTINCT FROM OLD.fx_rate_id
     OR NEW.fx_estimated IS DISTINCT FROM OLD.fx_estimated
     OR NEW.total_ghs IS DISTINCT FROM OLD.total_ghs
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.provenance_note IS DISTINCT FROM OLD.provenance_note
     OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key THEN
    RAISE EXCEPTION 'Invoice % financial snapshot is immutable; cancel it and issue a new invoice', OLD.invoice_ref
      USING ERRCODE = 'MV004';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    IF NEW.amount_paid_ghs IS DISTINCT FROM OLD.amount_paid_ghs THEN
      RAISE EXCEPTION 'amount_paid_ghs is derived from payments and cannot be set directly' USING ERRCODE = 'MV004';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status <> 'Cancelled' THEN
        RAISE EXCEPTION 'Invoice status is derived from payments; record or void a payment instead' USING ERRCODE = 'MV004';
      END IF;
      SELECT count(*) INTO v_active_payments FROM payments WHERE invoice_id = OLD.id AND status = 'completed';
      IF v_active_payments > 0 THEN
        RAISE EXCEPTION 'Invoice % has payments recorded; void them before cancelling', OLD.invoice_ref USING ERRCODE = 'MV005';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ============================== J. D9: registration activation ======================================================
ALTER TABLE registration_requests DROP CONSTRAINT registration_requests_status_check;     -- widened below
ALTER TABLE registration_requests ADD CONSTRAINT registration_requests_status_check
  CHECK (status IN ('pending','approved','activated','rejected','cancelled'));
ALTER TABLE registration_requests ADD COLUMN activated_at timestamptz;
ALTER TABLE registration_requests
  ADD CONSTRAINT registration_activated_state_chk CHECK ((status = 'activated') = (activated_at IS NOT NULL)),
  ADD CONSTRAINT registration_activated_links_chk CHECK (status <> 'activated' OR (resulting_customer_id IS NOT NULL AND resulting_user_id IS NOT NULL));
-- An approved-but-not-yet-activated request still blocks a second request for the same e-mail / phone.
DROP INDEX registration_open_email_uidx;
DROP INDEX registration_open_phone_uidx;
CREATE UNIQUE INDEX registration_open_email_uidx ON registration_requests (lower(email)) WHERE status IN ('pending','approved');
CREATE UNIQUE INDEX registration_open_phone_uidx ON registration_requests (phone_digits) WHERE status IN ('pending','approved') AND phone_digits <> '';

-- pending -> approved | rejected | cancelled ; approved -> activated | cancelled ; everything else is terminal.
CREATE FUNCTION registration_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved','rejected','cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('activated','cancelled'))) THEN
    RAISE EXCEPTION 'Registration request cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'MV005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registration_transition_guard BEFORE UPDATE OF status ON registration_requests
  FOR EACH ROW EXECUTE FUNCTION registration_transition_guard();

-- ============================== K. D8: user / customer state consistency ============================================
-- An active login can never belong to an inactive or archived customer ...
CREATE FUNCTION users_customer_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c customers;
BEGIN
  IF NEW.customer_id IS NOT NULL AND NEW.is_active THEN
    SELECT * INTO c FROM customers WHERE id = NEW.customer_id;
    IF c.status <> 'active' OR c.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'The customer is inactive or archived; its login cannot be active' USING ERRCODE = 'MV005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_customer_state_guard BEFORE INSERT OR UPDATE OF is_active, customer_id ON users
  FOR EACH ROW EXECUTE FUNCTION users_customer_state_guard();

-- ... and deactivating/archiving a customer deactivates its login(s), leaving a status event. History is untouched;
-- reactivating a customer does NOT silently reactivate the login (that is an explicit administrative act).
CREATE FUNCTION customers_deactivate_logins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status = 'active' AND OLD.archived_at IS NULL) AND (NEW.status <> 'active' OR NEW.archived_at IS NOT NULL) THEN
    WITH off AS (
      UPDATE users SET is_active = false, deactivated_at = now() WHERE customer_id = NEW.id AND is_active RETURNING id
    )
    INSERT INTO status_events (entity_type, entity_id, old_status, new_status, actor_type, reason)
    SELECT 'user', id, 'active', 'inactive', 'system', 'customer deactivated or archived' FROM off;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER customers_deactivate_logins AFTER UPDATE OF status, archived_at ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_deactivate_logins();
