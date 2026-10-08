-- 0016_import_framework: bookkeeping for the (future, separately approved) migration of legacy Airtable data.
--
-- Three append-only tables, owned by the migration role and NOT granted to the runtime role:
--   import_batches     one row per real import RUN (dry-runs never write anything): what snapshot, which importer version,
--                      who/what started it, counts. Identity columns are immutable; only a 'running' batch can be closed.
--   import_records     source -> target mapping: (source table, source record id) -> (target table, target id). The unique key
--                      is what makes an import idempotent and resumable, and what keeps every imported row traceable to its
--                      Airtable record without overloading business identifiers.
--   import_quarantine  every source record that was NOT imported, with category, severity, reason and field.
-- At most one batch may be 'running' at a time. Nothing here changes existing tables, grants or behaviour.

CREATE TABLE import_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                 text NOT NULL CHECK (mode IN ('import')),
  snapshot_fingerprint text NOT NULL CHECK (snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_label       text CHECK (length(snapshot_label) <= 200),
  snapshot_kind        text NOT NULL CHECK (snapshot_kind IN ('fixture', 'export')),
  snapshot_captured_at timestamptz,
  importer_version     text NOT NULL CHECK (btrim(importer_version) <> ''),
  source_tables        text[] NOT NULL,
  initiated_by         text NOT NULL CHECK (btrim(initiated_by) <> '' AND length(initiated_by) <= 200),
  environment_class    text NOT NULL CHECK (environment_class IN ('test', 'local', 'staging')),
  status               text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  counts               jsonb NOT NULL DEFAULT '{}'::jsonb,
  error                text CHECK (length(error) <= 2000),
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  CONSTRAINT import_batches_finished_chk CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX import_batches_one_running_uidx ON import_batches ((true)) WHERE status = 'running';
CREATE INDEX import_batches_snapshot_idx ON import_batches (snapshot_fingerprint, started_at);

CREATE TABLE import_records (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table        text NOT NULL CHECK (btrim(source_table) <> ''),
  source_id           text NOT NULL CHECK (btrim(source_id) <> '' AND length(source_id) <= 300),
  target_table        text NOT NULL CHECK (btrim(target_table) <> ''),
  target_id           text NOT NULL CHECK (btrim(target_id) <> ''),
  batch_id            uuid NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_records_source_uk UNIQUE (source_table, source_id),
  CONSTRAINT import_records_target_uk UNIQUE (target_table, target_id)
);
CREATE INDEX import_records_batch_idx ON import_records (batch_id);

CREATE TABLE import_quarantine (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id     uuid NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  source_table text NOT NULL CHECK (btrim(source_table) <> ''),
  source_id    text NOT NULL CHECK (btrim(source_id) <> '' AND length(source_id) <= 300),
  category     text NOT NULL CHECK (category ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  severity     text NOT NULL CHECK (severity IN ('blocking', 'review', 'deferred')),
  reason       text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 1000),
  field        text CHECK (length(field) <= 100),
  context      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_quarantine_batch_idx ON import_quarantine (batch_id, source_table);
CREATE INDEX import_quarantine_source_idx ON import_quarantine (source_table, source_id);

-- append-only bookkeeping
CREATE FUNCTION import_bookkeeping_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'import_batches' AND TG_OP = 'UPDATE' THEN
    -- a running batch may be closed (status, counts, error, finished_at); its identity never changes; a closed batch is final
    IF OLD.status <> 'running'
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.snapshot_fingerprint IS DISTINCT FROM OLD.snapshot_fingerprint
       OR NEW.snapshot_label IS DISTINCT FROM OLD.snapshot_label OR NEW.snapshot_kind IS DISTINCT FROM OLD.snapshot_kind
       OR NEW.snapshot_captured_at IS DISTINCT FROM OLD.snapshot_captured_at OR NEW.importer_version IS DISTINCT FROM OLD.importer_version
       OR NEW.source_tables IS DISTINCT FROM OLD.source_tables OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
       OR NEW.environment_class IS DISTINCT FROM OLD.environment_class OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'Import batch metadata is immutable' USING ERRCODE = 'MV004';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'MV004';
END $$;
REVOKE ALL ON FUNCTION import_bookkeeping_guard() FROM PUBLIC;
CREATE TRIGGER import_batches_guard BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_records_guard BEFORE UPDATE OR DELETE ON import_records FOR EACH ROW EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_quarantine_guard BEFORE UPDATE OR DELETE ON import_quarantine FOR EACH ROW EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_batches_no_truncate BEFORE TRUNCATE ON import_batches FOR EACH STATEMENT EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_records_no_truncate BEFORE TRUNCATE ON import_records FOR EACH STATEMENT EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_quarantine_no_truncate BEFORE TRUNCATE ON import_quarantine FOR EACH STATEMENT EXECUTE FUNCTION import_bookkeeping_guard();

-- Not for the application: the runtime role gets no privilege on these tables (explicit, in case default privileges ever change).
REVOKE ALL ON import_batches, import_records, import_quarantine FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'movezz_app') THEN
    REVOKE ALL ON import_batches, import_records, import_quarantine FROM movezz_app;
  END IF;
END $$;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_quarantine ENABLE ROW LEVEL SECURITY;      -- no policy: nothing is visible to a role that is not the owner

-- ============================== historical cancellation by the import actor ===========================================
-- invoices_actor_stamp (0013) allows only a super_admin to cancel an invoice. A historical invoice that was cancelled in the legacy
-- system must be recorded as cancelled (D3: never deleted or rewritten), and its voided payments must be inserted while it is still
-- open (payments are refused on a cancelled invoice). So the signed IMPORT actor may cancel NON-NATIVE invoices only; everything else
-- (native invoices, every other actor) is exactly as before: super_admin only. cancelled_by stays NULL (no user is invented).
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
    IF NOT (movezz_sec.current_actor_type() = 'import' AND NEW.provenance <> 'native')
       AND movezz_sec.actor_role() IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'Only a super_admin may cancel an invoice' USING ERRCODE = 'MV012';
    END IF;
    IF NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'cancelled_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.cancelled_by := v_actor;
  END IF;
  RETURN NEW;
END $$;
