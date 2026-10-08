-- 0003_identity: customers, users, registration requests.
-- Delete policy: nothing here is hard-deleted by the application. Customers are archived, users are deactivated.
-- All foreign keys are ON DELETE RESTRICT (the default NO ACTION semantics are made explicit).

CREATE TABLE customers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL CHECK (btrim(name) <> ''),
  phone                  text,
  phone_digits           text GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
  email                  text,
  shipping_mark          text NOT NULL CHECK (btrim(shipping_mark) <> ''),
  shipping_address       text,
  shipping_type          text CHECK (shipping_type IN ('air','sea')),
  package_tier           text NOT NULL DEFAULT 'basic' CHECK (package_tier IN ('basic','business','enterprise','special')),
  preferred_warehouse_id uuid REFERENCES warehouses (id) ON DELETE RESTRICT,
  notes                  text,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  archived_at            timestamptz,
  created_by             text,
  legacy_airtable_id     text,
  legacy_data            jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- an archived customer is never "active"
  CONSTRAINT customers_archived_inactive_chk CHECK (archived_at IS NULL OR status = 'inactive')
);
-- Shipping marks are globally unique, archived customers included (a mark must never be reused for a different person).
CREATE UNIQUE INDEX customers_shipping_mark_uidx ON customers (shipping_mark);
CREATE UNIQUE INDEX customers_legacy_uidx ON customers (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
-- NOT unique on purpose: Airtable never enforced uniqueness, so legacy data may contain duplicates. The application
-- checks duplicates on create; migration reports them for quarantine instead of failing.
CREATE INDEX customers_phone_digits_idx ON customers (phone_digits) WHERE phone_digits <> '';
CREATE INDEX customers_email_idx ON customers (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX customers_active_name_idx ON customers (name) WHERE archived_at IS NULL;
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Operational queries use this view so archived customers cannot leak into active lists by accident.
CREATE VIEW active_customers AS
  SELECT * FROM customers WHERE archived_at IS NULL AND status = 'active';

-- Users: identity comes from Firebase (auth_uid). No password column exists or will exist here.
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid           text NOT NULL CHECK (btrim(auth_uid) <> ''),
  email              text NOT NULL CHECK (email LIKE '%_@_%'),
  full_name          text,
  role               text NOT NULL CHECK (role IN ('super_admin','warehouse_staff','customer')),
  is_active          boolean NOT NULL DEFAULT true,
  deactivated_at     timestamptz,
  customer_id        uuid REFERENCES customers (id) ON DELETE RESTRICT,
  last_login_at      timestamptz,
  legacy_airtable_id text,
  legacy_data        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- customer logins MUST be linked to a customer; staff/admin logins MUST NOT be
  CONSTRAINT users_customer_link_chk CHECK ((role = 'customer') = (customer_id IS NOT NULL)),
  CONSTRAINT users_deactivation_chk  CHECK (is_active = (deactivated_at IS NULL))
);
CREATE UNIQUE INDEX users_auth_uid_uidx ON users (auth_uid);
CREATE UNIQUE INDEX users_email_uidx ON users (lower(email));
CREATE UNIQUE INDEX users_customer_uidx ON users (customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX users_legacy_uidx ON users (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX users_role_idx ON users (role) WHERE is_active;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- NOTE: there is deliberately no "first user becomes admin" logic anywhere in the database.

-- Public registration -> admin review -> activation. Only the data model exists in this phase.
CREATE TABLE registration_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (email LIKE '%_@_%'),
  name                text NOT NULL CHECK (btrim(name) <> ''),
  phone               text,
  phone_digits        text GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED,
  phone2              text,
  existing_mark       text,
  location            text,
  notes               text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at         timestamptz,
  rejection_reason    text,
  resulting_customer_id uuid REFERENCES customers (id) ON DELETE RESTRICT,
  resulting_user_id   uuid REFERENCES users (id) ON DELETE RESTRICT,
  legacy_airtable_id  text,
  legacy_data         jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_review_chk CHECK (status = 'pending' OR status = 'cancelled' OR reviewed_at IS NOT NULL),
  CONSTRAINT registration_reject_reason_chk CHECK (status <> 'rejected' OR btrim(coalesce(rejection_reason, '')) <> ''),
  CONSTRAINT registration_approved_chk CHECK (status <> 'approved' OR resulting_customer_id IS NOT NULL)
);
-- Duplicate prevention: at most one OPEN request per e-mail and per phone number.
CREATE UNIQUE INDEX registration_open_email_uidx ON registration_requests (lower(email)) WHERE status = 'pending';
CREATE UNIQUE INDEX registration_open_phone_uidx ON registration_requests (phone_digits) WHERE status = 'pending' AND phone_digits <> '';
CREATE UNIQUE INDEX registration_legacy_uidx ON registration_requests (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX registration_status_idx ON registration_requests (status, created_at);
CREATE TRIGGER registration_updated_at BEFORE UPDATE ON registration_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
