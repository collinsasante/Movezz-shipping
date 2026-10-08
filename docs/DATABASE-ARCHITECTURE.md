# Database architecture (Phase 6 — PostgreSQL foundation)

Status: **foundation only.** The schema, migrations, constraints, a small data-access layer and 96 integration tests
exist. The running application still uses Airtable; no routes were switched, no production data was migrated, nothing
was deployed. Passing migrations and tests does **not** make this database production-ready — see
["What has and has not been verified"](#what-has-and-has-not-been-verified).

> **Authoritative business rules:** [DECISIONS.md](DECISIONS.md) (25 decisions approved at the Phase 6 decision gate)
> take precedence over anything below. Where this document disagrees with it, DECISIONS.md wins; the known
> disagreements are listed in its "Conformance" table (container numbering §8, zero-value invoices §3/§9, cancellation
> release §9). The implementation has **not** yet been changed to match.

## 1. Decisions that shaped the schema

| Decision | Where it shows up |
|---|---|
| PostgreSQL 16 is the future source of truth; Airtable is retired later | `db/migrations`, `scripts/lib/migrate.mjs` |
| USD is the pricing currency; GHS is what the customer pays | `invoices` (frozen FX, `total_ghs`), `payments.amount_ghs` |
| Special rates are optional named cards chosen explicitly by staff (decision "A") | `special_rates`, `resolve_special_rate()`, `items` snapshots |
| `special` **package tier** and special-rate **cards** are different things | `package_rates.tier = 'special'` vs `special_rates` |
| Card amounts are USD (per CBM sea / per kg air) | `special_rates.sea_rate_usd / air_rate_usd` |
| No ORM; layered Route → Service → Repository → PostgreSQL | `src/lib/db/*` (plain `pg`, SQL in small functions) |
| Never default FX to 1; never trust client prices/bases | `current_fx_rate()` raises `MV001`; `priceItem()` |
| No cascading deletes; archive / deactivate / void / cancel instead | every FK is `ON DELETE RESTRICT`; tests assert none cascade |

Why plain `pg` and not an ORM: the project had no database layer at all; the important behavior here (locks,
generated columns, exclusion constraints, triggers, `NUMERIC` strings) is easiest to keep correct and reviewable as
SQL. `pg` is one small dependency, returns `NUMERIC` as strings (so money never becomes a JavaScript float), and
every repository function takes a `Queryable` so it can join a caller's transaction. An ORM can still be added later
on top of this schema if the team wants one.

## 2. Tables

```
                         warehouses ◄──────────────┐
                              ▲                    │
 users ──(customer_id)──► customers ──────────┐    │ preferred_warehouse_id
   │ ▲ one login per customer │                │    │
   │ └─ role = 'customer' ⇔ customer_id set    │    │
   │                          ├──► special_rates (optional customer_id; NULL = any customer)
   │                          │
   │              containers ◄┼──── items ────► cartons ──┐
   │                   ▲      │       │  ▲  (id,customer_id) composite FKs
   │ registration_     │      │       │  │ keep every link inside ONE customer
   │ requests          │      │       ▼  │
   │                   │      └─► invoices ◄── invoice_lines (item | carton | summary)
   │                   │             │  ▲
   │                   │             │  └── keepup_sync (state machine, retries)
   │                   │             ▼
   │                   │          payments (GHS, append-only, void = reversal)
   │
   ├──► status_events (append-only, polymorphic entity_id)
   ├──► audit_logs    (append-only, secrets scrubbed)
   └──► idempotency_keys (scope + actor + key)

 reference_counters  fx_rates  package_rates  suppliers  item_photos  notification_outbox  schema_migrations
```

| Table | Purpose | Delete/archive model |
|---|---|---|
| `users` | Firebase identity (`auth_uid`), role, active flag, optional `customer_id`. **No password column.** | deactivate (`is_active`, `deactivated_at`) |
| `customers` | Customer record, unique shipping mark, `phone_digits` (generated), tier, preferred warehouse | archive (`archived_at`, requires `status='inactive'`); view `active_customers` |
| `warehouses` | Pick-up/receiving locations | `is_active` |
| `suppliers` | Supplier directory (`SUP-0001`) | `archived_at` |
| `containers` | Shipments (`PMX-CON-YYYY-NNN`), status, dates, optional warehouse | `archived_at` (operational close) |
| `cartons` | First-class consolidated packages (`CTN-0001`), dimensions, **generated CBM**, price/rate/tier snapshot, `open→invoiced / dissolved` | state machine, never deleted |
| `items` | Received goods, generated CBM, tier **and** special price snapshots, `billing_basis` | `archived_at` |
| `item_photos` | Normalised photos (provider, public id, https URL) | `archived_at` |
| `invoices` | Immutable financial header (Airtable "Orders", ref `ORD-00001`) | `Cancelled` status, never deleted |
| `invoice_lines` | Immutable per-line pricing snapshot | append-only |
| `payments` | GHS ledger | append-only; void, never delete |
| `package_rates` | Current tier price list (one row per tier × freight × window) | `is_active` / window |
| `special_rates` | Optional named USD cards | `is_active` / window |
| `fx_rates` | USD→GHS history | `is_active` (runtime can only deactivate) |
| `status_events` | Append-only status history | append-only |
| `audit_logs` | Append-only audit trail | append-only |
| `idempotency_keys` | Duplicate-request protection | purged after `expires_at` |
| `keepup_sync` | Keepup synchronisation state | state machine |
| `registration_requests` | Public sign-up → review → activation | status machine |
| `notification_outbox` | Reliable notification queue | purged by retention job |
| `reference_counters` | Concurrency-safe reference numbers | monotonic |

Status values are the existing Airtable labels, stored verbatim in `CHECK` constraints (item: 7 statuses incl.
`Awaiting Customs Clearance & Duty Process`; container: `Loading / Shipped to Ghana / Arrived in Ghana`; invoice:
`Pending / Partial / Paid` plus the new `Cancelled`). This keeps API payloads unchanged and avoids a mapping layer.

## 3. Financial model

Precision: amounts `NUMERIC(14,2)` (up to 999,999,999,999.99), per-unit rates `NUMERIC(14,4)`, FX
`NUMERIC(18,8)`. No `real`, `double precision` or `money` column exists (a test fails if one is added). CBM is
unrounded `NUMERIC`; money is rounded **once**, at the end, with `round(x, 2)`.

An invoice stores, at creation and forever: `subtotal_usd`, `discount_usd`, `total_usd` (generated =
subtotal − discount), `fx_rate` (GHS per USD), `fx_rate_id` (the `fx_rates` row used), `fx_estimated`, `total_ghs`,
`amount_paid_ghs`, `balance_ghs` (generated = total − paid).

Enforced by the database:

* `total_ghs = round(total_usd × fx_rate, 2)` unless `fx_estimated` (reconstructed legacy invoices, decision Q17).
* `discount_usd ≤ subtotal_usd`; `amount_paid_ghs ≤ total_ghs` (no overpayment).
* Snapshot columns (`subtotal`, `discount`, `fx_*`, `total_ghs`, `customer_id`, `invoice_ref`, idempotency key) cannot
  be updated — corrections are cancel-and-reissue. (Phase 5 allowed editing the discount after creation; that is the
  one deliberate behavior change, because an editable total defeats a frozen snapshot.)
* Lines: `line_total = round(quantity × unit_price, 2)`; the lines must sum to the subtotal **at commit** (deferred
  constraint trigger). An invoice with no lines is allowed so legacy invoices without line data can be imported.
* `amount_paid_ghs` and the payment-driven status are derived: a direct `UPDATE` is rejected (`MV004`); only the
  payments trigger (trigger depth > 1) can set them.
* Payments are **GHS**, `> 0`; `usd_equivalent` is an optional historical snapshot that is never used in arithmetic.
* Missing FX: `current_fx_rate()` raises `MV001` → `FX_RATE_MISSING`. There is no fallback value anywhere.

Because lines carry their own `unit_price_usd`, `rate_usd`, `package_tier`, `billing_basis` and special-rate name
snapshots, an invoice stays reproducible when package rates, special rates, the customer's tier, the item or FX change
(tested).

## 4. Special rates (optional, explicit, validated)

```
special_rates(name, customer_id NULL|uuid, sea_rate_usd, air_rate_usd, is_active, effective_from, effective_to)
```

* Not every customer or item has one; the `items.billing_basis` default is `tier`.
* `customer_id IS NULL` → any customer may be given the card; otherwise only that customer.
* **Nothing selects a card automatically.** Staff pass `specialRateId` to `priceItem()`. The server then calls
  `resolve_special_rate(card, item.customer, now())`, which raises `MV002` unless the card exists, is active, is inside
  `[effective_from, effective_to)` (half-open), and is global or belongs to that customer. On failure nothing is written.
* A trigger (`items_special_rate_guard`) re-runs the same check whenever `items.special_rate_id` is set or changed, so
  SQL that bypasses the service cannot attach an inapplicable card either.
* Item snapshot: `billing_basis`, `special_rate_id` (nullable FK), `special_rate_name`, `special_rate_usd`,
  `special_price_usd`, alongside the always-computed tier snapshot (`tier_rate_usd`, `tier_price_usd`). Constraints:
  `special` basis requires the name + price snapshot; `tier` basis cannot carry a card id; a special item cannot be in a
  carton (existing rule).
* Uniqueness: an exclusion constraint forbids two **active** cards with the same `(name, customer_id)` whose windows
  overlap; `customer_id` is mapped to the nil UUID inside the constraint so duplicate active **global** cards are
  prevented too (a plain unique index treats NULLs as distinct). Inactive, non-overlapping (expired/future) cards
  coexist as history; a customer-specific card may share a global card's name.
* Editing or deactivating a card never changes stored snapshots or invoices. Referenced cards cannot be deleted.
* The `special` **package tier** is unrelated: it is just another row set in `package_rates` and yields
  `billing_basis = 'tier'`.

Limits: Airtable's `SpecialRates` has only `Name/Sea/Air`, so imported cards become *global, active, open-ended* cards
unless the owner supplies customer/validity data; old items keep only the name + price snapshot (`special_rate_id`
NULL) because their card may no longer exist.

## 5. Ownership and roles

* `users.role ∈ {super_admin, warehouse_staff, customer}`; `role='customer' ⇔ customer_id IS NOT NULL`; one login per
  customer; case-insensitive unique e-mail; unique `auth_uid`. The database never promotes anyone to admin.
* `items`, `cartons`, `invoices` carry `customer_id`; `invoice_lines` and `payments` are reached through
  `invoices.customer_id`. Composite foreign keys `(carton_id, customer_id)` / `(invoice_id, customer_id)` make it
  impossible for an item to reference another customer's carton or invoice; a trigger does the same for invoice lines.
  Repositories filter by the authenticated user's `customer_id` (never a client-supplied one); the data model supports
  that filter on every customer-facing table (tested).
* Staff powers over rates/FX/users/reports are an application-layer rule (Q9 is still undecided); the schema keeps those
  tables separate (`package_rates`, `special_rates`, `fx_rates`, `users`, `payments`) so each can be guarded
  independently.

## 6. Status history, audit, idempotency

* `status_events(entity_type, entity_id, old_status, new_status, actor, reason, metadata, occurred_at)` — append-only
  (UPDATE/DELETE/TRUNCATE raise `MV004`, runtime role has INSERT/SELECT only). `entity_id` is polymorphic with no FK on
  purpose so history survives any change to the row it describes; imported rows keep `legacy_record_ref`.
* `audit_logs` — append-only, `before_data/after_data` pass through `audit_redact()` (keys matching
  password/secret/token/api key/authorization/cookie/signature become `[REDACTED]`, recursively). Retention: kept in the
  primary database for 24 months, then exported by a privileged job; application code can never delete or update rows.
* `idempotency_keys` — unique on `(scope, actor, key)`; stores a request fingerprint, result entity and response. The
  same key with a different body is `IDEMPOTENCY_CONFLICT`; a different user (or scope) can never collide with or replay
  someone else's key. Keys expire after 30 days (purge job).

## 7. Keepup and notifications

`keepup_sync(kind invoice|payment, invoice_id, payment_id, keepup_sale_id, external_status, sync_state, idempotency_key,
attempt_count, last_attempt_at, next_retry_at, last_success_at, last_error, response_meta)`.

States: `pending → creating → synced | failed | needs_reconciliation | cancelled`. A worker (later phase) claims
`pending/failed` rows with `next_retry_at <= now()`, writes `creating` **before** calling Keepup, and records the sale id
on success. A crash or timeout after the request was sent leaves `creating`/`needs_reconciliation`, which must be
reconciled against Keepup before any retry (Keepup is not assumed to offer idempotency or webhooks — unverified).
One sync row per invoice, one per payment, unique idempotency key, unique Keepup sale id. Invoice creation inserts the
`pending` row in the same transaction; **no Keepup call is made anywhere in this phase.**

`notification_outbox` rows (`email`/`whatsapp`, payload, attempts, `next_attempt_at`, `dedupe_key`) are inserted in the
same transaction as the business change; a worker sends them later. Nothing is sent now.

## 8. Reference numbers

`allocate_reference(type, scope)` → `INSERT … ON CONFLICT DO UPDATE … RETURNING` on `reference_counters`. The row lock
serialises allocators of the same type, so numbers are unique under concurrency (tested with 60 parallel callers); a
rolled-back transaction releases its number (no gaps among committed references). Formats are unchanged from
`src/lib/utils.ts`: `ITM-0001`, `ORD-00001`, `SUP-0001`, `CTN-0001`, `PMX-CON-2026-001`. Padding never truncates
(`CTN-10000`). **Superseded behavior (do not rely on it):** containers restart at 001 each calendar year (scope = year). **SUPERSEDED by DECISIONS.md D1:** the container
sequence must be globally monotonic and must NOT restart; the implementation still restarts and must be corrected. `seed_reference_counter()` lifts a counter above
imported legacy references.

## 9. Transaction boundaries

| Operation | Single transaction contains |
|---|---|
| `createInvoice` | idempotency claim → lock customer/items/cartons (ownership + state) → price from stored snapshots → FX → subtotal/total in `NUMERIC` → reference → invoice → lines → link items → invoice cartons → status events → audit → `keepup_sync` pending → outbox → complete idempotency |
| `recordPayment` | idempotency claim → insert payment (trigger: lock invoice row, reject overpayment/cancelled, recompute paid/status, status event) → audit → complete idempotency |
| `voidPayment` | void update (same lock order) → status event → audit; invoice paid/balance/status recomputed by trigger |
| `cancelInvoice` | lock invoice → cancel (refused while completed payments exist) → status event → audit |
| `priceItem` | lock item → tier price → optional validated card → snapshot update |
| reference allocation | one statement inside the caller's transaction |

Rollback leaves nothing behind, including the reference number and the idempotency row (tested).
Not yet implemented as service functions (their tables/constraints exist): carton create/edit/dissolve with member
re-pricing, invoice regeneration, item status cascade, registration approval.

## 10. Concurrency strategy

Row locks (`FOR UPDATE` on the invoice for every payment and void, on items/cartons when invoicing), unique indexes
(idempotency, references, Keepup ids, payment idempotency key and Keepup payment reference), exclusion constraints (rate
windows), and `CHECK`s as a final backstop. No sleeps or retry loops. Tested with real parallel connections: references
(60), payments (10 over a balance → exactly 3 succeed; 4 exactly settling → all succeed), duplicate payment key (12),
duplicate invoice key (12), same item with different keys (exactly one wins), invoice numbers across customers (15),
invoice-vs-dissolve race on one carton, concurrent carton re-dimensioning (CBM stays consistent).

## 11. Indexes (and why)

| Index | Query it serves |
|---|---|
| `users(auth_uid)` unique, `users(lower(email))` unique | login lookup; case-insensitive uniqueness |
| `customers(shipping_mark)` unique, `phone_digits`, `lower(email)`, partial `WHERE archived_at IS NULL` | customer lookup/search; active lists |
| `items(customer_id, created_at DESC) WHERE archived_at IS NULL` | customer item list + ownership filter |
| `items(status)`, `items(container_id)`, `items(carton_id)`, `items(invoice_id)`, `items(customer_id) WHERE invoice_id IS NULL` | operations screens; "ready to invoice" |
| `cartons(customer_id, status)`, partial `status='open'`, `container_id`, `invoice_id` | carton lists; invoicing |
| `invoices(customer_id, created_at DESC)` | customer invoice list + ownership filter |
| `invoices(status, created_at DESC) WHERE status IN ('Pending','Partial')` | outstanding/sync |
| `invoices(keepup_sale_id)` unique partial; `invoices(external_idempotency_key)` unique partial | Keepup reconciliation; replay |
| `payments(invoice_id, created_at)`; unique `idempotency_key`; unique completed `keepup_reference` | ledger; duplicate protection |
| `status_events(entity_type, entity_id, occurred_at)` | history of one entity |
| `audit_logs(entity_type, entity_id, created_at)`, `(actor_user_id, created_at)`, `(created_at)` | audit lookups, retention export |
| `package_rates / fx_rates` lookup indexes (`… DESC` on effective date, `WHERE is_active`) | current rate resolution |
| `special_rates(customer_id)`, `(name, effective_from) WHERE is_active` | card lookup |
| `keepup_sync(next_retry_at) WHERE state IN (pending, failed)`; `(updated_at) WHERE creating/needs_reconciliation` | worker queue; reconciliation |
| `notification_outbox(next_attempt_at) WHERE status IN (pending, failed)` | worker queue |
| `registration_requests` partial unique (open e-mail / phone), `(status, created_at)` | duplicate prevention; review queue |
| `idempotency_keys(expires_at)` | purge |

Every `legacy_airtable_id` has a partial unique index (NULLs never collide). Indexes were chosen from the queries the
current routes run (Airtable `filterByFormula` use) and should be revisited with real data volumes and `EXPLAIN`.

## 12. Migration system and local setup

* `db/migrations/NNNN_name.sql`, contiguous numbering, **forward-only**. `scripts/lib/migrate.mjs` runs each file in its
  own transaction with its `schema_migrations` row, stores a SHA-256 checksum and refuses to continue if an applied file
  was edited, takes an advisory lock, refuses non-local hosts without `--confirm-host=<host>`, and never drops, truncates
  or resets anything. Fresh database → exact schema from migrations alone (tested, including failure rollback).
* No migration reads Airtable or contains data or secrets. Destructive-SQL review: the migrations contain no `DROP`,
  `TRUNCATE` or `DELETE`; a test scans for them.
* `CREATE EXTENSION btree_gist` is the only privileged statement (needed for exclusion constraints); it is a standard
  contrib extension available on managed PostgreSQL.
* Local: `scripts/db-local.sh start | reset | stop | env` (local PostgreSQL 16 binaries, or Docker via
  `docker-compose.db.yml` — the compose path could not be exercised in the build environment). `npm run db:migrate`
  (uses `MIGRATION_DATABASE_URL`), `npm run db:status`, `npm run test:db` (uses `MOVEZZ_TEST_PG_URL`; each test file
  creates and drops its own database and refuses non-local hosts).

## 13. Database security

* Two roles per environment, created by an operator with `db/roles/create-roles.sql` (passwords passed as psql
  variables, never stored): `movezz_migrator` (owns objects, runs migrations) and `movezz_app` (runtime: DML only, no
  DDL/TRUNCATE, not superuser, no `BYPASSRLS`). The application reads `DATABASE_URL` (runtime role) only; migrations read
  `MIGRATION_DATABASE_URL` only. Neither is logged or committed (`.env.example` lists placeholders).
* Hard deletes are withheld from the runtime role everywhere except `idempotency_keys` and `notification_outbox`;
  append-only tables are INSERT/SELECT only (tests prove `42501`).
* Use separate databases and credentials for development, staging and production; never share staging with production.
* Production TLS: connect with `sslmode=verify-full` (`DATABASE_SSL=true` makes `getPool()` verify certificates), do not
  expose port 5432 publicly (private network/VPN or Cloudflare Tunnel), restrict by firewall/security group.
* Backup safety: no extensions or objects outside `public`, no unlogged tables, all state in ordinary tables; `pg_dump`
  / PITR work unchanged. Backups themselves belong to the infrastructure phase.
* Row-level security was **not** used: ownership is enforced in repositories plus composite FKs. RLS with a per-request
  `SET LOCAL app.customer_id` is a possible later hardening.

## 14. Legacy (Airtable) mapping

| Airtable table | PostgreSQL | Notes |
|---|---|---|
| Customers | `customers` | `legacy_airtable_id`, unknown fields in `legacy_data`; duplicate phones are allowed in the schema and reported for quarantine |
| Users | `users` | customer users without a resolvable customer, or duplicate e-mails, are **quarantined**, not inserted |
| Items | `items`, `item_photos` | `CartonNumber` text → `cartons` rows (+ `legacy_data`); Photos → `item_photos.legacy_attachment_id`; `EstShippingPrice/IsSpecialItem/specialRateName` → special snapshot; `PkgEstShipping` (which was overwritten by carton shares) is only a hint |
| Orders | `invoices` (+ `invoice_lines` where reconstructable, `payments` from Keepup per Q17) | `fx_estimated = true` when the historical rate is unknown |
| Containers | `containers` | `DepartureDate` → `eta`; `Name` → `shipping_line`; `TrackingNumber` → `container_number` |
| StatusHistory | `status_events` | `RecordID` → `legacy_record_ref` until the entity is mapped; `actor_type='import'` |
| ActivityLogs | `audit_logs` | `actor_type='import'` |
| Suppliers / Warehouses / PackageRates / SpecialRates / Settings / PendingRegistrations | `suppliers` / `warehouses` / `package_rates` (row split into sea + air) / `special_rates` / `fx_rates` (one initial row, source `airtable-settings`) / `registration_requests` | |

Constraints are strict for new data and the migration is expected to **quarantine rather than weaken** them: rows that
would violate a `NOT NULL/CHECK/UNIQUE` (duplicate shipping marks, customer logins with no customer, negative
dimensions, an air carton without weight, two active same-name cards, invoices whose lines do not sum) go to a
quarantine report for human review. Call `seed_reference_counter()` after import.

## What has and has not been verified

Verified (automated, real PostgreSQL 16.15): migrations from an empty database; every constraint, trigger and grant
described above; USD/GHS/FX snapshot behavior; special-rate validity and uniqueness; append-only ledgers; idempotency;
concurrency scenarios listed in §10; the runtime role's lack of delete/DDL rights.

**Not** verified / open:

1. The real Airtable schema and data (Q2). Field meanings (`EstPrice`, `PkgShippingRate`), status vocabularies, and the
   data-quality problems that will need quarantine are unknown until an export exists.
2. Query performance with production volumes; index choices are reasoned, not measured.
3. `pg` on the Cloudflare Workers runtime (TCP sockets/`nodejs_compat`) versus a VPS/Node host: the runtime target for
   the PostgreSQL phase is undecided. The data layer is not imported by any route yet, so today's build is unaffected.
4. Docker Compose path, TLS connections, role creation script and managed-host extension permissions were not run here.
5. Keepup: idempotency/webhook support, zero-total behavior and payment listing remain unverified.
6. Business rules not invented here and still open: what cancelling an invoice does to its items/cartons (they are
   merely un-frozen); whether unpriced items may ever be invoiced (the service refuses); zero-value invoice policy; Q9
   staff powers; Q10 customer self-edit; inactive-customer semantics; customer-specific/validity data for special cards;
   container sequence restart per year (see §8).
7. Reconciliation with the parallel branch `origin/feat/signup-password-activation`: it assumes the *customer* record
   carries the Firebase UID and creates/re-points `Users` rows. In this schema the UID lives only on `users.auth_uid`
   (one login per customer), and public sign-up should create a `registration_requests` row. Resolve when that branch is
   reconciled; this phase did not touch the sign-up flow.
8. Remaining Phase 5 items this schema supports but does not yet implement (cross-instance atomic payments, reference
   sequences, FX snapshots, special-rate customer scope) are now *possible*, but only after the application is moved onto
   these tables.
