-- 0018_photo_rehost_log: append-only audit of every attempt to move an Airtable-hosted item photo to Cloudinary
-- (scripts/db-rehost-photos.mjs). A photo is DONE when item_photos.storage_provider <> 'airtable'; this table only records attempts,
-- so the tool is resumable and the outcome is auditable. Rows are never edited or deleted, and no item_photos row is ever deleted.
-- Owner-only like the other migration bookkeeping tables: the runtime role has no access. No URL query strings are stored
-- (Airtable attachment URLs can carry signatures).
CREATE TABLE photo_rehost_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         uuid NOT NULL,
  photo_id       uuid NOT NULL REFERENCES item_photos (id) ON DELETE RESTRICT,
  item_id        uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  outcome        text NOT NULL CHECK (outcome IN ('uploaded', 'failed')),
  error_class    text CHECK (error_class IN ('source_inaccessible', 'rejected', 'provider_error', 'invalid_response', 'concurrent_change')),
  error_detail   text CHECK (length(error_detail) <= 300),
  source_host    text,
  source_path    text CHECK (length(source_path) <= 300),
  public_id      text,
  new_url        text,
  attempted_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT photo_rehost_outcome_chk CHECK ((outcome = 'uploaded') = (public_id IS NOT NULL AND new_url IS NOT NULL AND error_class IS NULL))
);
CREATE INDEX photo_rehost_log_photo_idx ON photo_rehost_log (photo_id, id);
CREATE TRIGGER photo_rehost_log_guard BEFORE UPDATE OR DELETE ON photo_rehost_log FOR EACH ROW EXECUTE FUNCTION import_bookkeeping_guard();
CREATE TRIGGER photo_rehost_log_no_truncate BEFORE TRUNCATE ON photo_rehost_log FOR EACH STATEMENT EXECUTE FUNCTION import_bookkeeping_guard();
REVOKE ALL ON photo_rehost_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'movezz_app') THEN
    REVOKE ALL ON photo_rehost_log FROM movezz_app;
  END IF;
END $$;
ALTER TABLE photo_rehost_log ENABLE ROW LEVEL SECURITY;
