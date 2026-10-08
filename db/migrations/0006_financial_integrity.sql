-- 0006_financial_integrity: invoice lines, payments, and the integrity triggers that make the money model safe.
-- Principles: invoices and their lines are immutable snapshots; payments are append-only (void, never delete);
-- invoice paid/balance/status are DERIVED from payments inside the same transaction; overpayment is impossible.

-- Special-basis items can never sit in a carton (existing business rule: "Special-rate items can't be repacked").
ALTER TABLE items ADD CONSTRAINT items_special_not_in_carton_chk CHECK (billing_basis = 'tier' OR carton_id IS NULL);

-- ---------------------------------------------------------------------------------------------------------
-- Items: a special-rate card reference must be applicable to the item's customer at the moment it is applied.
CREATE FUNCTION items_special_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.special_rate_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.special_rate_id IS DISTINCT FROM OLD.special_rate_id) THEN
    PERFORM resolve_special_rate(NEW.special_rate_id, NEW.customer_id, now());   -- raises MV002 when not applicable
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_special_rate_guard BEFORE INSERT OR UPDATE OF special_rate_id ON items
  FOR EACH ROW EXECUTE FUNCTION items_special_rate_guard();

-- Items: price snapshots are frozen while the item sits on a live (non-cancelled) invoice.
CREATE FUNCTION items_invoiced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF OLD.invoice_id IS NOT NULL THEN
    SELECT status INTO v_status FROM invoices WHERE id = OLD.invoice_id;
    IF v_status IS DISTINCT FROM 'Cancelled' AND (
         NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.package_tier IS DISTINCT FROM OLD.package_tier
      OR NEW.tier_rate_usd IS DISTINCT FROM OLD.tier_rate_usd
      OR NEW.tier_price_usd IS DISTINCT FROM OLD.tier_price_usd
      OR NEW.billing_basis IS DISTINCT FROM OLD.billing_basis
      OR NEW.special_rate_id IS DISTINCT FROM OLD.special_rate_id
      OR NEW.special_rate_name IS DISTINCT FROM OLD.special_rate_name
      OR NEW.special_rate_usd IS DISTINCT FROM OLD.special_rate_usd
      OR NEW.special_price_usd IS DISTINCT FROM OLD.special_price_usd
      OR NEW.est_price_usd IS DISTINCT FROM OLD.est_price_usd) THEN
      RAISE EXCEPTION 'Item % is on a live invoice; its owner and price snapshots can no longer be changed', OLD.item_ref
        USING ERRCODE = 'MV004';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_invoiced_freeze BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION items_invoiced_freeze();

-- Cartons: invoiced cartons are frozen; dissolved is terminal.
CREATE FUNCTION cartons_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF OLD.status = 'dissolved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Carton % is dissolved and cannot be changed', OLD.carton_ref USING ERRCODE = 'MV005';
  END IF;
  IF OLD.status = 'invoiced' THEN
    SELECT status INTO v_status FROM invoices WHERE id = OLD.invoice_id;
    IF v_status IS DISTINCT FROM 'Cancelled' AND (
         NEW.status IS DISTINCT FROM OLD.status
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.freight_type IS DISTINCT FROM OLD.freight_type
      OR NEW.length IS DISTINCT FROM OLD.length OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height
      OR NEW.dimension_unit IS DISTINCT FROM OLD.dimension_unit
      OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
      OR NEW.package_tier IS DISTINCT FROM OLD.package_tier
      OR NEW.rate_usd IS DISTINCT FROM OLD.rate_usd
      OR NEW.price_usd IS DISTINCT FROM OLD.price_usd
      OR NEW.pricing_basis IS DISTINCT FROM OLD.pricing_basis) THEN
      RAISE EXCEPTION 'Carton % is invoiced and cannot be changed or dissolved', OLD.carton_ref USING ERRCODE = 'MV004';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cartons_freeze BEFORE UPDATE ON cartons FOR EACH ROW EXECUTE FUNCTION cartons_freeze();

-- ---------------------------------------------------------------------------------------------------------
-- Invoice lines: one per billing group (a single item, a carton, or a summary line). Immutable snapshots.
CREATE TABLE invoice_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         uuid NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  line_no            integer NOT NULL CHECK (line_no > 0),
  item_id            uuid REFERENCES items (id) ON DELETE RESTRICT,
  carton_id          uuid REFERENCES cartons (id) ON DELETE RESTRICT,
  description        text NOT NULL,                              -- snapshot, as printed on the invoice
  quantity           numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_usd     numeric(14,2) NOT NULL CHECK (unit_price_usd >= 0),
  line_total_usd     numeric(14,2) NOT NULL CHECK (line_total_usd >= 0),
  billing_basis      text NOT NULL CHECK (billing_basis IN ('tier','special')),
  package_tier       text CHECK (package_tier IN ('basic','business','enterprise','special')),   -- tier snapshot
  rate_usd           numeric(14,4) CHECK (rate_usd >= 0),                                        -- per-unit rate snapshot actually used
  special_rate_id    uuid REFERENCES special_rates (id) ON DELETE RESTRICT,
  special_rate_name  text,                                                                       -- name snapshot
  metadata           jsonb,                                                                      -- cbm, tracking number, ... as they were
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_lines_line_uk UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_lines_one_target_chk CHECK (item_id IS NULL OR carton_id IS NULL),
  CONSTRAINT invoice_lines_total_chk CHECK (line_total_usd = round(quantity * unit_price_usd, 2)),
  CONSTRAINT invoice_lines_special_chk CHECK (billing_basis <> 'special' OR special_rate_name IS NOT NULL)
);
CREATE INDEX invoice_lines_item_idx ON invoice_lines (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX invoice_lines_carton_idx ON invoice_lines (carton_id) WHERE carton_id IS NOT NULL;
CREATE INDEX invoice_lines_special_idx ON invoice_lines (special_rate_id) WHERE special_rate_id IS NOT NULL;

CREATE FUNCTION invoice_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_inv invoices; v_owner uuid;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = NEW.invoice_id;
  IF v_inv.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Invoice % is cancelled', v_inv.invoice_ref USING ERRCODE = 'MV005';
  END IF;
  IF NEW.item_id IS NOT NULL THEN
    SELECT customer_id INTO v_owner FROM items WHERE id = NEW.item_id;
    IF v_owner IS DISTINCT FROM v_inv.customer_id THEN
      RAISE EXCEPTION 'Invoice line item belongs to another customer' USING ERRCODE = 'MV004';
    END IF;
  END IF;
  IF NEW.carton_id IS NOT NULL THEN
    SELECT customer_id INTO v_owner FROM cartons WHERE id = NEW.carton_id;
    IF v_owner IS DISTINCT FROM v_inv.customer_id THEN
      RAISE EXCEPTION 'Invoice line carton belongs to another customer' USING ERRCODE = 'MV004';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_before_insert BEFORE INSERT ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_before_insert();

CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'MV004';
END $$;
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER invoice_lines_no_truncate BEFORE TRUNCATE ON invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Lines must add up to the invoice subtotal (checked at COMMIT so lines can be inserted in any order).
-- An invoice with no lines is allowed: legacy invoices may have none (reconstruction rule Q17).
CREATE FUNCTION invoice_lines_sum_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sum numeric; v_sub numeric;
BEGIN
  SELECT sum(line_total_usd) INTO v_sum FROM invoice_lines WHERE invoice_id = NEW.invoice_id;
  SELECT subtotal_usd INTO v_sub FROM invoices WHERE id = NEW.invoice_id;
  IF v_sum IS DISTINCT FROM v_sub THEN
    RAISE EXCEPTION 'Invoice lines total % does not equal the invoice subtotal %', v_sum, v_sub USING ERRCODE = 'MV006';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_lines_sum_check AFTER INSERT ON invoice_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_lines_sum_check();

-- Invoice guard: financial snapshot columns never change; paid amount and payment-driven status change only via the
-- payments trigger (trigger depth > 1); cancellation is the only direct status change and needs a clean payment slate.
CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_active_payments integer;
BEGIN
  IF OLD.status = 'Cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Invoice % is cancelled and cannot be changed', OLD.invoice_ref USING ERRCODE = 'MV004';
  END IF;
  IF NEW.invoice_ref IS DISTINCT FROM OLD.invoice_ref
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.subtotal_usd IS DISTINCT FROM OLD.subtotal_usd
     OR NEW.discount_usd IS DISTINCT FROM OLD.discount_usd
     OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
     OR NEW.fx_rate_id IS DISTINCT FROM OLD.fx_rate_id
     OR NEW.fx_estimated IS DISTINCT FROM OLD.fx_estimated
     OR NEW.total_ghs IS DISTINCT FROM OLD.total_ghs
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
CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Payments: canonical currency GHS. Append-only; a correction voids the payment (reversal), never deletes it.
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         uuid NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  amount_ghs         numeric(14,2) NOT NULL CHECK (amount_ghs > 0),            -- THE payment amount
  usd_equivalent     numeric(14,2) CHECK (usd_equivalent >= 0),                -- historical snapshot only; never used for balances
  method             text NOT NULL DEFAULT 'other' CHECK (btrim(method) <> ''),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','keepup','import')),
  external_reference text,
  keepup_reference   text,
  idempotency_key    text,
  status             text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  paid_at            timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  voided_at          timestamptz,
  voided_by          uuid REFERENCES users (id) ON DELETE RESTRICT,
  void_reason        text,
  legacy_airtable_id text,
  legacy_data        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_void_chk CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CONSTRAINT payments_void_reason_chk CHECK (status <> 'voided' OR btrim(coalesce(void_reason, '')) <> '')
);
CREATE UNIQUE INDEX payments_idem_uidx ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_keepup_ref_uidx ON payments (keepup_reference) WHERE keepup_reference IS NOT NULL AND status = 'completed';
CREATE UNIQUE INDEX payments_legacy_uidx ON payments (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX payments_invoice_idx ON payments (invoice_id, created_at);

CREATE FUNCTION recompute_invoice_payments(p_invoice_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_inv  invoices;
  v_paid numeric(14,2);
  v_new  text;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  SELECT coalesce(sum(amount_ghs), 0) INTO v_paid FROM payments WHERE invoice_id = p_invoice_id AND status = 'completed';
  v_new := CASE
    WHEN v_inv.status = 'Cancelled' THEN 'Cancelled'
    WHEN v_paid > 0 AND v_paid >= v_inv.total_ghs THEN 'Paid'
    WHEN v_paid > 0 THEN 'Partial'
    ELSE 'Pending'
  END;
  UPDATE invoices SET amount_paid_ghs = v_paid, status = v_new WHERE id = p_invoice_id;   -- depth > 1: allowed by invoices_guard
  IF v_new IS DISTINCT FROM v_inv.status THEN
    INSERT INTO status_events (entity_type, entity_id, old_status, new_status, actor_type, reason)
    VALUES ('invoice', p_invoice_id, v_inv.status, v_new, 'system', 'payment ledger changed');
  END IF;
END $$;

-- status_events is created in 0007; this function is only called at run time, after both migrations are applied.
CREATE FUNCTION payments_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_inv invoices; v_paid numeric(14,2);
BEGIN
  -- Serialise every payment for this invoice: concurrent requests queue here, and each sees the others' committed rows.
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
CREATE TRIGGER payments_before_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_before_insert();

CREATE FUNCTION payments_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_invoice_payments(NEW.invoice_id);
  RETURN NULL;
END $$;
CREATE TRIGGER payments_after_change AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_after_change();

-- Only completed -> voided is allowed, with every other column unchanged.
CREATE FUNCTION payments_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM 1 FROM invoices WHERE id = OLD.invoice_id FOR UPDATE;   -- same lock order as inserts
  RETURN NEW;
END $$;
CREATE TRIGGER payments_before_update BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_before_update();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
