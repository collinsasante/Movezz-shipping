-- 0007_history_integration: status events, audit log, idempotency, Keepup sync state, notification outbox.

-- Append-only status history. entity_id is polymorphic (no FK) on purpose: it must survive any later change to the
-- referenced row, and one table serves every entity. legacy_record_ref keeps the Airtable RecordID of imported rows.
CREATE TABLE status_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type        text NOT NULL CHECK (entity_type IN ('item','container','carton','invoice','payment','customer','user','registration_request','keepup_sync')),
  entity_id          uuid,
  old_status         text,
  new_status         text NOT NULL,
  actor_user_id      uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_type         text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','import','integration')),
  reason             text,
  metadata           jsonb,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  legacy_airtable_id text,
  legacy_record_ref  text,
  CONSTRAINT status_events_target_chk CHECK (entity_id IS NOT NULL OR legacy_record_ref IS NOT NULL)
);
CREATE INDEX status_events_entity_idx ON status_events (entity_type, entity_id, occurred_at);
CREATE UNIQUE INDEX status_events_legacy_uidx ON status_events (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE TRIGGER status_events_append_only BEFORE UPDATE OR DELETE ON status_events FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER status_events_no_truncate BEFORE TRUNCATE ON status_events FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Audit log. Secrets are scrubbed from before/after by a trigger, so a careless caller cannot persist them.
-- Retention model: kept indefinitely in the primary database for 24 months, then exported to cold storage by a
-- privileged job (never by application code). Partitioning by created_at can be added later without API change.
CREATE FUNCTION audit_redact(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; out jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) = 'object' THEN
    out := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(p) LOOP
      IF k ~* '(pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|signature)' THEN
        out := out || jsonb_build_object(k, '[REDACTED]');
      ELSE
        out := out || jsonb_build_object(k, audit_redact(p -> k));
      END IF;
    END LOOP;
    RETURN out;
  ELSIF jsonb_typeof(p) = 'array' THEN
    RETURN coalesce((SELECT jsonb_agg(audit_redact(e)) FROM jsonb_array_elements(p) e), '[]'::jsonb);
  END IF;
  RETURN p;
END $$;

CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','import','integration')),
  action        text NOT NULL CHECK (btrim(action) <> ''),
  entity_type   text NOT NULL,
  entity_id     text,
  before_data   jsonb,
  after_data    jsonb,
  request_id    text,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at) WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
CREATE FUNCTION audit_logs_redact_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.before_data := audit_redact(NEW.before_data);
  NEW.after_data  := audit_redact(NEW.after_data);
  NEW.user_agent  := left(NEW.user_agent, 400);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_logs_redact BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_redact_trigger();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Idempotency keys. Uniqueness is per (scope, actor, key) so one user can never replay another user's key.
CREATE TABLE idempotency_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL CHECK (btrim(scope) <> ''),          -- e.g. 'invoice.create', 'payment.create', 'keepup.sale.create'
  actor_user_id      uuid REFERENCES users (id) ON DELETE RESTRICT,
  key                text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash       text,                                              -- fingerprint: same key + different body is a client error
  status             text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','failed')),
  result_entity_type text,
  result_entity_id   uuid,
  response           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);
CREATE UNIQUE INDEX idempotency_keys_uidx ON idempotency_keys (scope, coalesce(actor_user_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Keepup synchronisation state (Keepup is an external channel; Movezz owns the invoice/payment records).
-- No assumption is made that Keepup offers idempotency or webhooks: the row records what we attempted and what
-- we know so a worker can retry and reconcile. Nothing here calls Keepup.
CREATE TABLE keepup_sync (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('invoice','payment')),
  invoice_id         uuid NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  payment_id         uuid REFERENCES payments (id) ON DELETE RESTRICT,
  keepup_sale_id     text,
  external_status    text,
  sync_state         text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','creating','synced','failed','needs_reconciliation','cancelled')),
  idempotency_key    text NOT NULL,
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at    timestamptz,
  next_retry_at      timestamptz,
  last_success_at    timestamptz,
  last_error         text CHECK (length(last_error) <= 2000),
  response_meta      jsonb,                                              -- safe, minimal fields only; never credentials
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keepup_sync_payment_chk CHECK ((kind = 'payment') = (payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX keepup_sync_invoice_uidx ON keepup_sync (invoice_id) WHERE kind = 'invoice';
CREATE UNIQUE INDEX keepup_sync_payment_uidx ON keepup_sync (payment_id) WHERE kind = 'payment';
CREATE UNIQUE INDEX keepup_sync_idem_uidx ON keepup_sync (idempotency_key);
CREATE UNIQUE INDEX keepup_sync_sale_uidx ON keepup_sync (keepup_sale_id) WHERE keepup_sale_id IS NOT NULL AND kind = 'invoice';
CREATE INDEX keepup_sync_due_idx ON keepup_sync (next_retry_at) WHERE sync_state IN ('pending','failed');
CREATE INDEX keepup_sync_recon_idx ON keepup_sync (updated_at) WHERE sync_state IN ('creating','needs_reconciliation');
CREATE TRIGGER keepup_sync_updated_at BEFORE UPDATE ON keepup_sync FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Notification outbox (written in the same transaction as the business change; a worker sends later).
CREATE TABLE notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL CHECK (btrim(event_type) <> ''),
  channel         text NOT NULL CHECK (channel IN ('email','whatsapp')),
  recipient       text NOT NULL CHECK (btrim(recipient) <> ''),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','dead','cancelled')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  last_error      text CHECK (length(last_error) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_sent_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE UNIQUE INDEX outbox_dedupe_uidx ON notification_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status IN ('pending','failed');
CREATE TRIGGER outbox_updated_at BEFORE UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION set_updated_at();
