-- 0001_foundation: extensions, helper functions, reference counters.
-- Additive only. btree_gist is needed for exclusion constraints (rate-window overlap prevention).
-- It is a standard contrib extension; creating it needs a role allowed to CREATE EXTENSION (the migration role).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Generic updated_at maintenance --------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Controlled business errors ------------------------------------------------------------------
-- Application code maps these SQLSTATEs to typed errors:
--   MV001 FX rate missing        MV002 special rate not applicable     MV003 overpayment
--   MV004 immutable record       MV005 invalid state transition        MV006 unpriced item / invalid invoice input
-- (Custom SQLSTATEs must be 5 chars of 0-9/A-Z; class "MV" is not used by PostgreSQL.)

-- Reference counters ---------------------------------------------------------------------------
-- Replaces count()+1 (which produced duplicates after deletes and under concurrency).
-- One row per (type, scope). The UPDATE ... RETURNING takes the row lock, so concurrent allocators of the
-- SAME type queue behind each other and every number is unique; a rolled-back transaction releases its number
-- (gapless). Scope is '' except containers, whose sequence restarts per calendar year (format PMX-CON-YYYY-NNN).
CREATE TABLE reference_counters (
  ref_type   text   NOT NULL,
  scope      text   NOT NULL DEFAULT '',
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ref_type, scope),
  CONSTRAINT reference_counters_type_chk CHECK (ref_type IN ('item','invoice','container','supplier','carton'))
);

CREATE FUNCTION format_reference(p_type text, p_scope text, p_n bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits text := p_n::text;
BEGIN
  -- lpad() would TRUNCATE a number longer than the pad width, so pad by hand.
  RETURN CASE p_type
    WHEN 'item'      THEN 'ITM-' || repeat('0', greatest(4 - length(digits), 0)) || digits
    WHEN 'invoice'   THEN 'ORD-' || repeat('0', greatest(5 - length(digits), 0)) || digits
    WHEN 'supplier'  THEN 'SUP-' || repeat('0', greatest(4 - length(digits), 0)) || digits
    WHEN 'carton'    THEN 'CTN-' || repeat('0', greatest(4 - length(digits), 0)) || digits
    WHEN 'container' THEN 'PMX-CON-' || p_scope || '-' || repeat('0', greatest(3 - length(digits), 0)) || digits
    ELSE NULL
  END;
END $$;

CREATE FUNCTION allocate_reference(p_type text, p_scope text DEFAULT '') RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_scope text := coalesce(p_scope, '');
  v_n     bigint;
BEGIN
  IF p_type = 'container' AND v_scope !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'container references need a 4-digit year scope' USING ERRCODE = 'MV006';
  END IF;
  INSERT INTO reference_counters (ref_type, scope, last_value) VALUES (p_type, v_scope, 1)
  ON CONFLICT (ref_type, scope) DO UPDATE
    SET last_value = reference_counters.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_n;
  RETURN format_reference(p_type, v_scope, v_n);
END $$;

-- Migration support: make sure the next allocated number is above every legacy reference already imported.
CREATE FUNCTION seed_reference_counter(p_type text, p_scope text, p_at_least bigint) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO reference_counters (ref_type, scope, last_value) VALUES (p_type, coalesce(p_scope, ''), p_at_least)
  ON CONFLICT (ref_type, scope) DO UPDATE
    SET last_value = greatest(reference_counters.last_value, excluded.last_value), updated_at = now();
$$;
