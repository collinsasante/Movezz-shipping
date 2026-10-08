-- 0005_operations: containers, invoices (header), cartons, items, item photos.
-- Ownership: items/cartons/invoices carry customer_id. Composite foreign keys (id, customer_id) make it impossible
-- for an item to point at another customer's carton or invoice, whatever the application sends.
-- Delete policy: ON DELETE RESTRICT everywhere (no cascading deletes of operational or financial history).

CREATE TABLE containers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_ref      text NOT NULL UNIQUE,                    -- PMX-CON-2026-001
  container_number   text CHECK (container_number IS NULL OR btrim(container_number) <> ''),  -- shipping-line container no.; mandatory in the app, nullable for legacy
  shipping_line      text,                                    -- Airtable "Name"
  description        text,
  status             text NOT NULL DEFAULT 'Loading' CHECK (status IN ('Loading','Shipped to Ghana','Arrived in Ghana')),
  eta                date,                                    -- Airtable DepartureDate (the code calls it ETA)
  arrival_date       date,
  warehouse_id       uuid REFERENCES warehouses (id) ON DELETE RESTRICT,
  notes              text,
  created_by         text,
  archived_at        timestamptz,                             -- operational close/archive instead of delete
  legacy_airtable_id text,
  legacy_data        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX containers_legacy_uidx ON containers (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX containers_status_idx ON containers (status) WHERE archived_at IS NULL;
CREATE INDEX containers_eta_idx ON containers (eta DESC);
CREATE TRIGGER containers_updated_at BEFORE UPDATE ON containers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Invoices (Airtable "Orders"). Financial columns are frozen at creation (see 0006 guard trigger).
-- Money model: USD is the pricing currency, GHS the payment currency; the FX rate used is stored on the invoice.
CREATE TABLE invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_ref             text NOT NULL UNIQUE,               -- ORD-00001 (kept: customers know it)
  customer_id             uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  invoice_date            date NOT NULL DEFAULT current_date,
  status                  text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Partial','Paid','Cancelled')),
  subtotal_usd            numeric(14,2) NOT NULL CHECK (subtotal_usd >= 0),
  discount_usd            numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_usd >= 0),
  total_usd               numeric(14,2) GENERATED ALWAYS AS (subtotal_usd - discount_usd) STORED,
  fx_rate                 numeric(18,8) NOT NULL CHECK (fx_rate > 0),   -- GHS per 1 USD, frozen at creation; never defaulted
  fx_rate_id              uuid REFERENCES fx_rates (id) ON DELETE RESTRICT,   -- the rate row it was taken from (null for estimated legacy)
  fx_estimated            boolean NOT NULL DEFAULT false,     -- true when reconstructed from history rather than known (decision Q17)
  total_ghs               numeric(14,2) NOT NULL CHECK (total_ghs >= 0),
  amount_paid_ghs         numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid_ghs >= 0),   -- maintained ONLY by the payments trigger
  balance_ghs             numeric(14,2) GENERATED ALWAYS AS (total_ghs - amount_paid_ghs) STORED,
  keepup_sale_id          text,
  keepup_link             text,
  external_idempotency_key text,                              -- key the creating request used (also in idempotency_keys)
  notes                   text,
  created_by              uuid REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at            timestamptz,
  cancelled_by            uuid REFERENCES users (id) ON DELETE RESTRICT,
  cancel_reason           text,
  legacy_airtable_id      text,
  legacy_data             jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_discount_chk   CHECK (discount_usd <= subtotal_usd),
  -- no overpayment, ever (the payments trigger recomputes amount_paid_ghs, so a too-large payment fails here)
  CONSTRAINT invoices_overpaid_chk   CHECK (amount_paid_ghs <= total_ghs),
  -- GHS total must be exactly round(USD total x frozen rate); estimated legacy reconstructions are exempt
  CONSTRAINT invoices_fx_total_chk   CHECK (fx_estimated OR total_ghs = round((subtotal_usd - discount_usd) * fx_rate, 2)),
  CONSTRAINT invoices_cancel_chk     CHECK ((status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT invoices_cancel_reason_chk CHECK (status <> 'Cancelled' OR btrim(coalesce(cancel_reason, '')) <> ''),
  CONSTRAINT invoices_id_customer_uk UNIQUE (id, customer_id)
);
CREATE UNIQUE INDEX invoices_legacy_uidx ON invoices (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_keepup_sale_uidx ON invoices (keepup_sale_id) WHERE keepup_sale_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_idem_uidx ON invoices (external_idempotency_key) WHERE external_idempotency_key IS NOT NULL;
CREATE INDEX invoices_customer_idx ON invoices (customer_id, created_at DESC);          -- customer invoice list, ownership filter
CREATE INDEX invoices_status_idx ON invoices (status, created_at DESC) WHERE status IN ('Pending','Partial');  -- outstanding / sync
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cartons are first-class records (previously only a text label copied onto items).
CREATE TABLE cartons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carton_ref         text NOT NULL UNIQUE,                    -- CTN-0001
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  container_id       uuid REFERENCES containers (id) ON DELETE RESTRICT,
  freight_type       text NOT NULL CHECK (freight_type IN ('sea','air')),
  length             numeric(10,2) CHECK (length > 0),
  width              numeric(10,2) CHECK (width > 0),
  height             numeric(10,2) CHECK (height > 0),
  dimension_unit     text NOT NULL DEFAULT 'cm' CHECK (dimension_unit IN ('cm','inches')),
  weight_kg          numeric(10,3) CHECK (weight_kg > 0),
  -- CBM is DERIVED by the database; it cannot be supplied or drift. cm^3 / 1e6, inches use 16.387064 cm^3 per in^3.
  cbm                numeric GENERATED ALWAYS AS (
                       CASE WHEN length IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
                            THEN length * width * height * (CASE WHEN dimension_unit = 'inches' THEN 16.387064 ELSE 1 END) / 1000000
                       END) STORED,
  package_tier       text NOT NULL CHECK (package_tier IN ('basic','business','enterprise','special')),  -- snapshot of the customer's tier when priced
  rate_usd           numeric(14,4) CHECK (rate_usd >= 0),     -- snapshot of the per-unit tier rate used
  price_usd          numeric(14,2) CHECK (price_usd >= 0),    -- snapshot of the carton price
  pricing_basis      text NOT NULL DEFAULT 'tier' CHECK (pricing_basis IN ('tier','special')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','invoiced','dissolved')),
  invoice_id         uuid,
  dissolved_at       timestamptz,
  created_by         text,
  legacy_data        jsonb,                                   -- cartons had no Airtable record; legacy = the CartonNumber text on items
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cartons_invoice_state_chk  CHECK ((status = 'invoiced') = (invoice_id IS NOT NULL)),
  CONSTRAINT cartons_dissolved_chk      CHECK ((status = 'dissolved') = (dissolved_at IS NOT NULL)),
  CONSTRAINT cartons_air_weight_chk     CHECK (freight_type <> 'air' OR weight_kg IS NOT NULL),
  CONSTRAINT cartons_sea_dims_chk       CHECK (freight_type <> 'sea' OR (length IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL)),
  CONSTRAINT cartons_id_customer_uk UNIQUE (id, customer_id),
  CONSTRAINT cartons_invoice_fk FOREIGN KEY (invoice_id, customer_id) REFERENCES invoices (id, customer_id) ON DELETE RESTRICT
);
CREATE INDEX cartons_customer_idx ON cartons (customer_id, status);
CREATE INDEX cartons_open_idx ON cartons (customer_id) WHERE status = 'open';
CREATE INDEX cartons_container_idx ON cartons (container_id) WHERE container_id IS NOT NULL;
CREATE INDEX cartons_invoice_idx ON cartons (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE TRIGGER cartons_updated_at BEFORE UPDATE ON cartons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Items. An item keeps its OWN price snapshot; it is never overwritten by carton membership (the Airtable
-- "PkgEstShipping" overwrite is what erased prices). A carton is billed through its own price_usd.
CREATE TABLE items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_ref           text NOT NULL UNIQUE,                    -- ITM-0001
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  container_id       uuid REFERENCES containers (id) ON DELETE RESTRICT,
  carton_id          uuid,
  invoice_id         uuid,
  received_date      date,
  description        text NOT NULL DEFAULT '',
  tracking_number    text,
  status             text NOT NULL DEFAULT 'Arrived at Transit Warehouse' CHECK (status IN (
                       'Arrived at Transit Warehouse','Shipped to Ghana','Arrived in Ghana',
                       'Awaiting Customs Clearance & Duty Process','Sorting','Ready for Pickup','Completed')),
  is_missing         boolean NOT NULL DEFAULT false,
  freight_type       text CHECK (freight_type IN ('sea','air')),
  weight_kg          numeric(10,3) CHECK (weight_kg >= 0),
  length             numeric(10,2) CHECK (length >= 0),
  width              numeric(10,2) CHECK (width >= 0),
  height             numeric(10,2) CHECK (height >= 0),
  dimension_unit     text NOT NULL DEFAULT 'cm' CHECK (dimension_unit IN ('cm','inches')),
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  cbm_per_unit       numeric GENERATED ALWAYS AS (
                       CASE WHEN length IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
                            THEN length * width * height * (CASE WHEN dimension_unit = 'inches' THEN 16.387064 ELSE 1 END) / 1000000
                       END) STORED,
  cbm_total          numeric GENERATED ALWAYS AS (
                       CASE WHEN length IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL
                            THEN length * width * height * (CASE WHEN dimension_unit = 'inches' THEN 16.387064 ELSE 1 END) / 1000000 * quantity
                       END) STORED,
  -- pricing snapshots (USD). Meaning of the Airtable fields they come from: PkgShippingRate, PkgEstShipping, EstPrice.
  est_price_usd      numeric(14,2) CHECK (est_price_usd >= 0),     -- Airtable EstPrice (meaning not verifiable without the production base)
  package_tier       text CHECK (package_tier IN ('basic','business','enterprise','special')),
  tier_rate_usd      numeric(14,4) CHECK (tier_rate_usd >= 0),      -- per-unit tier rate used
  tier_price_usd     numeric(14,2) CHECK (tier_price_usd >= 0),     -- price at the tier rate
  billing_basis      text NOT NULL DEFAULT 'tier' CHECK (billing_basis IN ('tier','special')),
  special_rate_id    uuid REFERENCES special_rates (id) ON DELETE RESTRICT,   -- the card staff selected (validated by trigger)
  special_rate_name  text,                                          -- snapshot (survives card edits/removal)
  special_rate_usd   numeric(14,4) CHECK (special_rate_usd >= 0),   -- per-unit special rate used
  special_price_usd  numeric(14,2) CHECK (special_price_usd >= 0),  -- price at the special rate
  notes              text,
  created_by         text,
  archived_at        timestamptz,
  legacy_airtable_id text,
  legacy_data        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- billing on the special basis requires the special snapshot; a card reference never rides on a tier item
  CONSTRAINT items_special_basis_chk CHECK (billing_basis <> 'special' OR (special_rate_name IS NOT NULL AND special_price_usd IS NOT NULL)),
  CONSTRAINT items_tier_basis_chk    CHECK (billing_basis <> 'tier' OR special_rate_id IS NULL),
  CONSTRAINT items_carton_fk  FOREIGN KEY (carton_id,  customer_id) REFERENCES cartons  (id, customer_id) ON DELETE RESTRICT,
  CONSTRAINT items_invoice_fk FOREIGN KEY (invoice_id, customer_id) REFERENCES invoices (id, customer_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX items_legacy_uidx ON items (legacy_airtable_id) WHERE legacy_airtable_id IS NOT NULL;
CREATE INDEX items_customer_idx ON items (customer_id, created_at DESC) WHERE archived_at IS NULL;   -- customer item list, ownership filter
CREATE INDEX items_status_idx ON items (status) WHERE archived_at IS NULL;
CREATE INDEX items_container_idx ON items (container_id) WHERE container_id IS NOT NULL;
CREATE INDEX items_carton_idx ON items (carton_id) WHERE carton_id IS NOT NULL;
CREATE INDEX items_invoice_idx ON items (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX items_uninvoiced_idx ON items (customer_id) WHERE invoice_id IS NULL AND archived_at IS NULL;   -- "items ready to invoice"
CREATE INDEX items_tracking_idx ON items (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX items_special_rate_idx ON items (special_rate_id) WHERE special_rate_id IS NOT NULL;
CREATE TRIGGER items_updated_at BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE item_photos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             uuid NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  storage_provider    text NOT NULL CHECK (storage_provider IN ('cloudinary','airtable','firebase_storage','other')),
  public_id           text,
  url                 text NOT NULL CHECK (url ~ '^https://'),
  width               integer CHECK (width > 0),
  height              integer CHECK (height > 0),
  metadata            jsonb,                                   -- never credentials or signed upload parameters
  sort_order          integer NOT NULL DEFAULT 0,
  legacy_attachment_id text,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_photos_item_idx ON item_photos (item_id, sort_order) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX item_photos_public_uidx ON item_photos (item_id, public_id) WHERE public_id IS NOT NULL;
CREATE UNIQUE INDEX item_photos_legacy_uidx ON item_photos (legacy_attachment_id) WHERE legacy_attachment_id IS NOT NULL;
