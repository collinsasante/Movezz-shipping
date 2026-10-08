-- 0011_authoritative_pricing: server-authoritative pricing and discount authority enforced IN the database (Phase 7D).
--
--   A. item_authoritative_price(): the single SQL definition of "what does this item cost" (tier / special, freight basis,
--      rounding). The pricing service and the invoice-line guard both use it; TypeScript holds no rates or formulas.
--   B. Discount authority: a native invoice with discount > 0 can only be inserted inside a transaction whose VERIFIED
--      actor (0010) is a user whose role in the database is super_admin. The client never supplies a role.
--   C. Native invoices must freeze the CURRENT authoritative USD->GHS rate (fx_rate must equal the referenced rate row).
--   D. Native item lines must equal item_authoritative_price() (billing basis, rate, card, unit price). Direct SQL cannot
--      write an invoice line with a made-up price.
--   E. Non-native provenance (which relaxes D/native rules) may only be written by the 'import' actor.
--   F. users is read-only for the runtime role except profile columns (pricing/discount authority reads users.role).
--
-- No table/column drops, no row rewrites. apply_runtime_grants() is replaced (it only narrows users and adds EXECUTE).

-- ============================== A. the pricing function ===============================================================
-- VOLATILE on purpose: it takes FOR SHARE locks on the rate rows it uses, so a concurrent rate edit waits for the invoice
-- transaction instead of producing prices from two rate versions.
CREATE FUNCTION item_authoritative_price(p_item_id uuid, p_special_rate_id uuid DEFAULT NULL)
RETURNS TABLE (billing_basis text, package_tier text, tier_rate_usd numeric, tier_price_usd numeric,
               special_rate_id uuid, special_rate_name text, special_rate_usd numeric, special_price_usd numeric)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i items; v_tier text; v_rate numeric; v_basis numeric; v_card special_rates; v_srate numeric; v_status text; v_arch timestamptz;
BEGIN
  SELECT * INTO i FROM items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'MV009'; END IF;
  SELECT c.package_tier INTO v_tier FROM customers c WHERE c.id = i.customer_id;
  IF v_tier IS NULL THEN RAISE EXCEPTION 'The customer has no package tier' USING ERRCODE = 'MV009'; END IF;
  IF i.freight_type IS NULL OR i.freight_type NOT IN ('sea','air') THEN
    RAISE EXCEPTION 'Item has no freight type' USING ERRCODE = 'MV010';
  END IF;
  IF i.freight_type = 'sea' THEN
    v_basis := i.cbm_total;
    IF v_basis IS NULL OR v_basis <= 0 THEN RAISE EXCEPTION 'Sea freight needs positive length, width and height' USING ERRCODE = 'MV010'; END IF;
  ELSE
    IF i.weight_kg IS NULL OR i.weight_kg <= 0 THEN RAISE EXCEPTION 'Air freight needs a positive weight' USING ERRCODE = 'MV010'; END IF;
    v_basis := i.weight_kg * i.quantity;
  END IF;

  -- package_rates_no_overlap guarantees at most one row; FOR SHARE keeps it from changing under this transaction
  SELECT r.rate_usd INTO v_rate FROM package_rates r
   WHERE r.tier = v_tier AND r.freight_type = i.freight_type AND r.is_active
     AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()) FOR SHARE;
  IF v_rate IS NULL THEN RAISE EXCEPTION 'No active % rate for the % tier', i.freight_type, v_tier USING ERRCODE = 'MV009'; END IF;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'The % rate for the % tier is not positive', i.freight_type, v_tier USING ERRCODE = 'MV010'; END IF;

  package_tier := v_tier; tier_rate_usd := v_rate; tier_price_usd := round(v_basis * v_rate, 2);
  IF tier_price_usd <= 0 THEN RAISE EXCEPTION 'The computed price is not positive' USING ERRCODE = 'MV010'; END IF;

  IF p_special_rate_id IS NULL THEN
    billing_basis := 'tier'; special_rate_id := NULL; special_rate_name := NULL; special_rate_usd := NULL; special_price_usd := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- explicit selection only; raises MV002 for unknown / inactive / not yet effective / expired / other customer's / wrong freight
  -- lock FIRST, then read: a concurrent edit of the card waits for this transaction, and what we read is what stays true
  PERFORM 1 FROM special_rates s WHERE s.id = p_special_rate_id FOR SHARE;
  v_card := resolve_special_rate(p_special_rate_id, i.customer_id, now(), i.freight_type);
  v_srate := CASE WHEN i.freight_type = 'sea' THEN v_card.sea_rate_usd ELSE v_card.air_rate_usd END;
  IF v_srate IS NULL OR v_srate <= 0 THEN
    RAISE EXCEPTION 'Special rate "%" has no positive % rate', v_card.name, i.freight_type USING ERRCODE = 'MV002';
  END IF;
  billing_basis := 'special'; special_rate_id := v_card.id; special_rate_name := v_card.name;
  special_rate_usd := v_srate; special_price_usd := round(v_basis * v_srate, 2);
  IF special_price_usd <= 0 THEN RAISE EXCEPTION 'The computed special price is not positive' USING ERRCODE = 'MV010'; END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION item_authoritative_price(uuid, uuid) FROM PUBLIC;

-- ============================== verified actor's database role =========================================================
-- The role is whatever movezz_sec.begin_actor read from public.users for THIS transaction; no caller input is involved.
CREATE FUNCTION movezz_sec.actor_role() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text;
BEGIN
  SELECT s.role INTO v FROM movezz_sec.actor_sessions s WHERE s.txid = pg_current_xact_id_if_assigned() AND s.actor_type = 'user';
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION movezz_sec.actor_role() FROM PUBLIC;

-- ============================== B/C/E. invoice insert guard ===========================================================
CREATE FUNCTION invoices_pricing_authority() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_type text := movezz_sec.current_actor_type(); v_fx fx_rates; v_cur fx_rates;
BEGIN
  IF NEW.provenance <> 'native' THEN
    IF v_type IS DISTINCT FROM 'import' THEN
      RAISE EXCEPTION 'Only the import actor may write non-native (historical) invoices' USING ERRCODE = 'MV006';
    END IF;
    RETURN NEW;   -- historical data keeps whatever the legacy system recorded (D11); it is marked, never presented as native
  END IF;

  -- discount authority (D16): super_admin only, decided from the database role of the verified actor
  IF NEW.discount_usd > 0 AND movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super_admin may grant a discount' USING ERRCODE = 'MV008';
  END IF;

  -- FX is frozen from the current authoritative rate row; the caller cannot choose a rate or an older row
  IF NEW.fx_rate_id IS NULL THEN RAISE EXCEPTION 'A native invoice must reference the FX rate row it froze' USING ERRCODE = 'MV011'; END IF;
  SELECT * INTO v_fx FROM fx_rates WHERE id = NEW.fx_rate_id;
  IF NOT FOUND OR v_fx.base_currency <> 'USD' OR v_fx.quote_currency <> 'GHS' OR NOT v_fx.is_active OR v_fx.rate IS DISTINCT FROM NEW.fx_rate THEN
    RAISE EXCEPTION 'The invoice FX rate does not match an active USD->GHS rate' USING ERRCODE = 'MV011';
  END IF;
  v_cur := current_fx_rate('USD', 'GHS', now());
  IF v_cur.id IS DISTINCT FROM v_fx.id THEN
    RAISE EXCEPTION 'The invoice FX rate is not the current USD->GHS rate' USING ERRCODE = 'MV011';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_pricing_authority BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_pricing_authority();
REVOKE ALL ON FUNCTION invoices_pricing_authority() FROM PUBLIC;

-- ============================== D. invoice line guard ================================================================
CREATE FUNCTION invoice_lines_pricing_authority() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_prov text; v_item items; v_carton cartons; p record; v_price numeric; v_rate numeric;
BEGIN
  SELECT provenance INTO v_prov FROM invoices WHERE id = NEW.invoice_id;
  IF v_prov IS DISTINCT FROM 'native' THEN
    IF movezz_sec.current_actor_type() IS DISTINCT FROM 'import' THEN
      RAISE EXCEPTION 'Only the import actor may write lines of a non-native invoice' USING ERRCODE = 'MV006';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.provenance <> 'native' THEN
    RAISE EXCEPTION 'A native invoice cannot carry non-native lines' USING ERRCODE = 'MV010';
  END IF;
  IF NEW.item_id IS NOT NULL THEN
    SELECT * INTO v_item FROM items WHERE id = NEW.item_id;
    SELECT * INTO p FROM item_authoritative_price(NEW.item_id,
        CASE WHEN v_item.billing_basis = 'special' THEN v_item.special_rate_id END);
    v_price := CASE WHEN p.billing_basis = 'special' THEN p.special_price_usd ELSE p.tier_price_usd END;
    v_rate  := CASE WHEN p.billing_basis = 'special' THEN p.special_rate_usd ELSE p.tier_rate_usd END;
    IF NEW.billing_basis IS DISTINCT FROM p.billing_basis
       OR NEW.unit_price_usd IS DISTINCT FROM v_price
       OR NEW.line_total_usd IS DISTINCT FROM NEW.unit_price_usd * NEW.quantity
       OR NEW.rate_usd IS DISTINCT FROM v_rate
       OR NEW.package_tier IS DISTINCT FROM p.package_tier
       OR NEW.special_rate_id IS DISTINCT FROM p.special_rate_id THEN
      RAISE EXCEPTION 'Invoice line does not match the authoritative price of the item' USING ERRCODE = 'MV010';
    END IF;
  ELSIF NEW.carton_id IS NOT NULL THEN
    -- cartons keep their stored price until the carton service exists (a later phase); the line must at least equal it
    SELECT * INTO v_carton FROM cartons WHERE id = NEW.carton_id;
    IF v_carton.price_usd IS NULL OR v_carton.price_usd <= 0 OR NEW.unit_price_usd IS DISTINCT FROM v_carton.price_usd
       OR NEW.billing_basis IS DISTINCT FROM v_carton.pricing_basis THEN
      RAISE EXCEPTION 'Invoice line does not match the carton price' USING ERRCODE = 'MV010';
    END IF;
  ELSE
    RAISE EXCEPTION 'A native invoice line must reference an item or a carton' USING ERRCODE = 'MV010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_pricing_authority BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_pricing_authority();
REVOKE ALL ON FUNCTION invoice_lines_pricing_authority() FROM PUBLIC;

-- ============================== F. runtime grants =====================================================================
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
  EXECUTE format('GRANT UPDATE (full_name, last_login_at) ON users TO %I', p_role);
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
                  movezz_sec.append_status_event(text, uuid, text, text, text, jsonb), movezz_sec.actor_role() TO %I', p_role);
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
