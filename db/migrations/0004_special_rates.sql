-- 0004_special_rates: named special rate cards (OPTIONAL; most customers and items never use one).
--
-- Approved model:
--   * a card is a named USD price list (sea = USD per CBM, air = USD per kg)
--   * customer_id NULL  => any customer may be given the card by staff
--   * customer_id set   => valid for that customer only
--   * the card is chosen EXPLICITLY by staff for an item; nothing here selects one automatically
--   * the card must be active and inside [effective_from, effective_to) when it is applied
-- This is unrelated to the 'special' package tier in package_rates (a separate concept, preserved as is).

CREATE TABLE special_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  customer_id        uuid REFERENCES customers (id) ON DELETE RESTRICT,
  sea_rate_usd       numeric(14,4) NOT NULL DEFAULT 0 CHECK (sea_rate_usd >= 0),
  air_rate_usd       numeric(14,4) NOT NULL DEFAULT 0 CHECK (air_rate_usd >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  effective_from     timestamptz NOT NULL DEFAULT now(),
  effective_to       timestamptz,                         -- first instant the card NO LONGER applies (half-open)
  legacy_airtable_id text,
  legacy_data        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT special_rates_window_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- One ACTIVE card per (name, customer_id) at any instant. NULL customer_id is mapped to the nil UUID so that two
  -- ACTIVE GLOBAL cards with the same name cannot overlap either (plain UNIQUE treats NULLs as distinct).
  -- Inactive or non-overlapping (expired / future) cards with the same name may coexist as history.
  CONSTRAINT special_rates_no_overlap EXCLUDE USING gist (
    name WITH =,
    (coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (is_active)
);
CREATE UNIQUE INDEX special_rates_legacy_uidx ON special_rates (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX special_rates_customer_idx ON special_rates (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX special_rates_active_idx ON special_rates (name, effective_from) WHERE is_active;
CREATE TRIGGER special_rates_updated_at BEFORE UPDATE ON special_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The single definition of "may this card be applied to this customer right now?".
-- Returns the card row or raises MV002 (unknown, inactive, expired, not yet effective, or another customer's).
CREATE FUNCTION resolve_special_rate(p_rate_id uuid, p_customer_id uuid, p_at timestamptz DEFAULT now())
RETURNS special_rates LANGUAGE plpgsql STABLE AS $$
DECLARE r special_rates;
BEGIN
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
  RETURN r;
END $$;
