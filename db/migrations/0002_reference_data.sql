-- 0002_reference_data: warehouses, suppliers, package rates, FX rates.
-- Money precision: NUMERIC(14,2) for amounts (max 999,999,999,999.99), NUMERIC(14,4) for per-unit rates,
-- NUMERIC(18,8) for FX. No floating point anywhere.

CREATE TABLE warehouses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (btrim(name) <> ''),
  address           text NOT NULL DEFAULT '',
  country           text,
  phone             text,
  is_active         boolean NOT NULL DEFAULT true,
  legacy_airtable_id text,
  legacy_data       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX warehouses_legacy_uidx ON warehouses (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
-- customers see only active warehouses; staff list both
CREATE INDEX warehouses_active_idx ON warehouses (name) WHERE is_active;
CREATE TRIGGER warehouses_updated_at BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_ref      text NOT NULL UNIQUE,                       -- SUP-0001
  name              text NOT NULL CHECK (btrim(name) <> ''),
  category          text,
  platform          text,
  platform_link     text,
  contact           text,
  contact_method    text,
  rating            smallint CHECK (rating BETWEEN 1 AND 5),
  notes             text,
  created_by        text,
  archived_at       timestamptz,
  legacy_airtable_id text,
  legacy_data       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_legacy_uidx ON suppliers (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX suppliers_active_idx ON suppliers (name) WHERE archived_at IS NULL;
CREATE TRIGGER suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Package (tier) rates. Airtable keeps one row per tier with Sea and Air columns; here one row per
-- (tier, freight type) so each rate has its own validity window. Sea is USD per CBM, air is USD per kg.
-- These are CURRENT price lists only: invoice lines and items store their own snapshots.
CREATE TABLE package_rates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier              text NOT NULL CHECK (tier IN ('basic','business','enterprise','special')),
  freight_type      text NOT NULL CHECK (freight_type IN ('sea','air')),
  rate_usd          numeric(14,4) NOT NULL CHECK (rate_usd >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,                                   -- first instant the rate NO LONGER applies (half-open)
  legacy_airtable_id text,
  legacy_data       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_rates_window_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- two ACTIVE rates for the same tier+freight may never overlap in time (no silent "pick one")
  CONSTRAINT package_rates_no_overlap EXCLUDE USING gist (
    tier WITH =, freight_type WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (is_active)
);
CREATE UNIQUE INDEX package_rates_legacy_uidx ON package_rates (legacy_airtable_id, freight_type) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX package_rates_lookup_idx ON package_rates (tier, freight_type, effective_from DESC) WHERE is_active;
CREATE TRIGGER package_rates_updated_at BEFORE UPDATE ON package_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- FX rates (quote units per 1 base unit; today USD -> GHS). Never defaulted: a missing rate is an error (MV001).
CREATE TABLE fx_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate           numeric(18,8) NOT NULL CHECK (rate > 0),
  source         text NOT NULL CHECK (btrim(source) <> ''),
  effective_at   timestamptz NOT NULL DEFAULT now(),
  is_active      boolean NOT NULL DEFAULT true,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fx_rates_pair_chk CHECK (base_currency <> quote_currency),
  CONSTRAINT fx_rates_unique_instant UNIQUE (base_currency, quote_currency, effective_at)
);
CREATE INDEX fx_rates_lookup_idx ON fx_rates (base_currency, quote_currency, effective_at DESC) WHERE is_active;

-- Rate in force at a point in time (latest active rate whose effective_at <= p_at). Raises MV001 when none.
CREATE FUNCTION current_fx_rate(p_base text DEFAULT 'USD', p_quote text DEFAULT 'GHS', p_at timestamptz DEFAULT now())
RETURNS fx_rates LANGUAGE plpgsql STABLE AS $$
DECLARE r fx_rates;
BEGIN
  SELECT * INTO r FROM fx_rates
   WHERE base_currency = p_base AND quote_currency = p_quote AND is_active AND effective_at <= p_at
   ORDER BY effective_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active % -> % exchange rate is configured', p_base, p_quote USING ERRCODE = 'MV001';
  END IF;
  RETURN r;
END $$;
