-- 0017_quarantine_resolution: an append-only audit of the DECISION taken for each quarantined source record.
-- The original import_quarantine row is never changed. A resolution never edits imported data and never invents values:
--   excluded                   the record is deliberately NOT migrated (reason required); it stays traceable via its quarantine row
--   corrected_in_new_snapshot  the source was corrected upstream; the corrected record must arrive through a NEW snapshot
--                              (its fingerprint is recorded) and the normal importer, with all its validation
-- Like the other import tables it is owner-only: the runtime role has no access.
CREATE TABLE import_quarantine_resolutions (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quarantine_id            bigint NOT NULL UNIQUE REFERENCES import_quarantine (id) ON DELETE RESTRICT,
  resolution               text NOT NULL CHECK (resolution IN ('excluded', 'corrected_in_new_snapshot')),
  reason                   text NOT NULL CHECK (length(btrim(reason)) >= 10 AND length(reason) <= 1000),
  new_snapshot_fingerprint text CHECK (new_snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  details                  jsonb,
  resolved_by              text NOT NULL CHECK (btrim(resolved_by) <> '' AND length(resolved_by) <= 200),
  resolved_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quarantine_resolution_snapshot_chk CHECK ((resolution = 'corrected_in_new_snapshot') = (new_snapshot_fingerprint IS NOT NULL))
);
CREATE TRIGGER import_quarantine_resolutions_guard BEFORE UPDATE OR DELETE ON import_quarantine_resolutions FOR EACH ROW EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER import_quarantine_resolutions_no_truncate BEFORE TRUNCATE ON import_quarantine_resolutions FOR EACH STATEMENT EXECUTE FUNCTION import_bookkeeping_guard();
REVOKE ALL ON import_quarantine_resolutions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'movezz_app') THEN
    REVOKE ALL ON import_quarantine_resolutions FROM movezz_app;
  END IF;
END $$;
ALTER TABLE import_quarantine_resolutions ENABLE ROW LEVEL SECURITY;
