# Phase 7I — Migration, import readiness, reconciliation and cutover preparation

**Scope of this phase:** build and test, with SYNTHETIC local fixtures only, the machinery that can later receive and reconcile the
existing Movezz data. **Nothing here was run against, or pointed at, Airtable, Firebase, Keepup, Cloudinary, Cloudflare or any
production database.** The final cutover (7J) is not part of this phase, and no worker, route or environment variable was switched.

Legend used below — **implemented** (code exists) · **tested locally** (automated tests against a disposable local PostgreSQL) ·
**requires production verification** · **requires business decision** · **deferred**.

## 1. Headline findings (read this first)

1. **The Airtable `Orders` table alone cannot be imported financially** (requires business decision / production verification).
   `InvoiceAmount` is USD at creation and is later overwritten with the net GHS amount after Keepup answered; there is no FX rate
   per order, and Airtable has **no payments table** (only `AmountPaid`/`BalanceDue` on the order). `docs/CHARACTERIZATION-BASELINE.md`
   findings #2–#5 and decisions D12/D15 forbid guessing. So the importer imports an order only when a **verified financial snapshot**
   exists for it (see §6), and **quarantines every other order** (`MISSING_VERIFIED_FINANCIALS`) together with the items that
   hang on it (importing them uninvoiced could double-bill). Producing that verified snapshot (from verified Keepup data, D15) is
   an open task for the cutover phase; until then every real invoice would be quarantined and the verdict would be `NOT_READY`.
2. **Historical logins are not imported** (decision proposed here, requires business confirmation). `users` needs a Firebase UID,
   and linking one from the old project would make production identities trusted by the new system (D22/D23). Users are
   validated and reported as *deferred*; people re-activate through the 7G registration flow.
3. **The importer runs with an owner-level database role**, as migrations do. The database's own guards still apply to it
   (actor required, immutability, constraints), but it *can* write tables the application role cannot. Its safety rests on the code,
   the environment guard and the post-import reconciliation (which fails if any user, Keepup row or notification appears).
   A dedicated, narrower import role is **deferred** (see §12).

## 2. Pipeline (implemented, tested locally)

```
SOURCE SNAPSHOT → DISCOVERY → NORMALIZATION → VALIDATION → QUARANTINE → IMPORT → RECONCILIATION → REPORT
 snapshot.mjs     snapshot.mjs  normalize.mjs  validate.mjs  validate.mjs  execute.mjs  reconcile.mjs   report.mjs
```

All code is in `scripts/lib/import/*.mjs` (plain ESM, runnable without a TypeScript runner, like `scripts/lib/migrate.mjs`);
`index.mjs` only wires the stages together and each stage is exported and tested on its own.

| Concept | Where |
|---|---|
| source record identity | `(source table, Airtable record id)`; derived cartons use `carton:<CartonNumber>`, multi-row targets `<id>#sea` / `#air`, photos `<item>#photo:<n>` |
| normalized record | `{ table, sourceId, row, rels, fp }` — `fp` is a content fingerprint |
| validation errors / warnings | issues with severity `blocking` (quarantined), `review` (imported, needs a look), `info` (counted only, e.g. a default the live app also applies) |
| quarantine reason | `import_quarantine`: table, source id, category, severity, reason, field, batch |
| imported record mapping | `import_records`: unique on source **and** on target |
| import batch | `import_batches` (immutable metadata) |
| reconciliation result | `reconcile.mjs` → checks + financial + integrity + security sections |

Entry points: `node scripts/db-import.mjs dry-run|import|reconcile --snapshot FILE` (§9), or the functions `dryRun`, `importSnapshot`,
`reconcileSnapshot` in `scripts/lib/import/index.mjs`.

### Snapshot format (untrusted input)

`{ format: "movezz-airtable-snapshot/1", source: { kind: "fixture"|"export", label, capturedAt }, tables: { <name>: [ { id, fields } ] } }`

Airtable tables (names as in `src/lib/airtable.ts`): Warehouses, Suppliers, PackageRates, SpecialRates, Settings, Customers, Users,
Containers, Items, Orders, StatusHistory, ActivityLogs, PendingRegistrations. **Supplemental verified tables** (a future
extraction, not Airtable): `VerifiedInvoices`, `VerifiedInvoiceLines`, `VerifiedPayments` (§6). Unknown tables are listed and
ignored. The snapshot is read from a local file only: it must resolve (symlinks included) inside the working directory, be a regular
file ≤ 64 MiB, ≤ 200 000 records per table; each record is scanned and **tainted** — quarantined, never normalized — when it has a
reserved key (`__proto__`, `constructor`, `prototype`), control characters, a string > 20 000 chars, > 200 fields, > 1000 list
entries or nesting > 6. Records are copied to null-prototype objects and only read through allow-lists.

## 3. Source → target mapping (implemented, tested locally)

| Source | Target | Notes |
|---|---|---|
| Warehouses | `warehouses` | `legacy_airtable_id` = record id |
| Suppliers | `suppliers` | `SupplierID` is kept as `supplier_ref` |
| PackageRates | `package_rates` ×2 | one row per freight; **current list only** (effective from import time); mapped as `<id>#sea`/`#air` |
| Settings.UsdToGhs | `fx_rates` (source `airtable-settings`) | the **current** rate only, effective at snapshot time; never applied to old invoices; missing/invalid/out of 0.1–1000 → quarantine, never `1` |
| SpecialRates | `special_rates` | `provenance = legacy_ambiguous`: customer association and validity are not in the source and are **not invented** (D11); a `0` rate means "not offered" (stored NULL) |
| Customers | `customers` | shipping mark **preserved verbatim** (non-standard marks are flagged, never regenerated); `inactive` stays `inactive`; **not** archived; Firebase UID not carried; unexpected fields kept (bounded) in `legacy_data` |
| Users | *(none)* | deferred, see §5 |
| Containers | `containers` | `ContainerID`→`container_ref`, `Name`→`shipping_line`, `DepartureDate`→`eta`, `TrackingNumber`→`container_number` |
| Items (+`CartonNumber`) | `items`, `cartons`, `item_photos` | cartons are **derived** from items sharing a `CartonNumber`; see below |
| Orders + Verified* | `invoices`, `invoice_lines`, `payments` | §6 |
| StatusHistory | `status_events` | `actor_type = import`, no user, `occurred_at` = source `ChangedAt`, `legacy_airtable_id` = source id, historical actor in `metadata` |
| ActivityLogs | `audit_logs` | `actor_type = import`, no user, `created_at` = source `Timestamp`, action `legacy:<Action>`, historical actor/details in `after_data.legacy` |
| PendingRegistrations | *(none)* | deferred (D9: the new registration flow starts clean) |

**Items.** The item keeps its own price snapshot. While an item sat in a carton Airtable overwrote `PkgEstShipping` with the carton
share, so inside a carton the item's tier price is taken from `PreCartonPkgEstShipping` or left unknown — never from the overwritten value.
A special item (`IsSpecialItem`) imports as `billing_basis = special` with the legacy snapshot (name, price, rate) and **no** card link.
**Cartons.** Members must agree on customer, container, freight type, unit, dimensions/weight and invoice; an air carton needs a
weight, a sea carton positive dimensions; otherwise the carton **and its members** are quarantined (`INVALID_CARTON`). The carton
price is the sum of the members' shares when all are present (else unpriced); its tier is the customer's package at import time
(the historical tier was not recorded — noted in `legacy_data`). A carton is `invoiced` when all members are on one live order.
**Cancelled orders.** Their items and cartons are imported **released** (uninvoiced), exactly as a cancellation in the new system
releases them (D3); the invoice lines remain as the historical record.

## 4. Import order (derived from the schema's foreign keys and guards; tested)

`warehouses → suppliers → package_rates → fx_rates → special_rates → customers → containers → invoices (headers) → cartons → items(+photos) → invoice_lines → payments → historical cancellations → status_events → audit_logs → reference counters → quarantine → batch closed`

Why this order and not the "obvious" one: an invoiced carton references its invoice, so invoices precede cartons; items reference
cartons and invoices; lines reference items and cartons and are checked (sum = subtotal) at COMMIT, so each invoice's lines are one
transaction; payments are refused on a cancelled invoice and a cancelled invoice may hold no payments that are completed, so payments
(inserted, then voided where the source says so, replayed in chronological order so a void frees balance for a later payment) come
first and the cancellation last. Migration 0016 lets the signed **import** actor perform that cancellation for **non-native**
invoices only; native cancellation is still super_admin-only (tested).

## 5. Identity (implemented, tested locally; requires business confirmation)

The importer creates no `users`, no `registration_requests`, no Firebase accounts, assigns no role and links no UID; a source
`Role`/`auth_uid`/`FirebaseUID`-like field can never reach a column (identity-looking *values* are not even preserved as text). Every
Users record is reported as `deferred` (`IDENTITY_NOT_IMPORTED`), with extra notes: duplicate e-mails/UIDs (`CONFLICTING_IDENTITY`,
review), customer logins whose customer is missing (`MISSING_CUSTOMER_REFERENCE`), `super_admin` rows (`PRIVILEGED_ROLE_NOT_IMPORTED`,
D23: the administrator is bootstrapped explicitly). The reconciliation fails if any imported `users` row exists.
Customers keep their identity (id mapping, mark, status) so a person who registers/activates later can be matched to the customer by
the approval workflow of 7G — that matching is **not** automated here.

## 6. Historical financial rules (implemented, tested locally; the data contract requires business decision)

Nothing historical is recalculated, repriced, converted or "fixed". The locked money model applies: USD pricing, frozen FX on the
invoice, payments in GHS, balance = invoice GHS − completed GHS payments (derived by the existing payments triggers).

An order is imported only with a **`VerifiedInvoices`** row (`OrderRecordID`, `SubtotalUsd`, `DiscountUsd`, `DiscountReason`, `FxRate`,
`TotalGhs`, optional `FxEstimated`+`Note`, `CancelledAt`, `CancelReason`) that satisfies the database's own rules: discount ≤ subtotal,
a reason for a discount, FX 0.1–1000, and `TotalGhs = round((subtotal − discount) × FxRate, 2)` half-up — **refused, not corrected**,
when it does not. `FxEstimated` is only accepted when the source explains it; the invoice then carries `provenance = estimated`.
Lines come from `VerifiedInvoiceLines` (must add up to the subtotal; an invoice with no lines is allowed and flagged `NO_LINE_DETAIL`).
Payments come only from `VerifiedPayments` (GHS only; `completed` or `voided` with date and reason). Airtable's own
`InvoiceAmount`/`Discount`/`AmountPaid`/`BalanceDue` are kept as *claims* in `legacy_data` and **compared**, never copied:

| Situation | Outcome |
|---|---|
| no verified snapshot, or one that does not add up | order quarantined (+ its items, lines, payments) |
| cancelled order with a completed payment | order quarantined (`CANCELLED_WITH_PAYMENT`); a *voided* payment is fine |
| payments exceed the total (chronological replay) | order quarantined (`OVERPAYMENT`) |
| any payment on a zero-value invoice (D4) | order quarantined |
| payment in another currency / unknown state / duplicate key or Keepup reference | that payment (and the order) quarantined |
| Airtable status / paid amount / balance disagrees with the verified data | **imported as verified, reported as a discrepancy** (never repaired) → verdict `NOT_READY` |

Keepup: the Airtable `KeepupSaleId` is preserved on the invoice (unique); **no** `keepup_sync` row and no notification is created.

## 7. Quarantine (implemented, tested locally)

Every record that is not imported is stored in `import_quarantine` with the batch, source table, source id, category, severity,
reason and field (`blocking` = needs a human; `review` = imported with a warning; `deferred` = excluded by design). Categories include
`MISSING_CUSTOMER_REFERENCE, DUPLICATE_CUSTOMER, INVALID_MONEY, INVALID_FX, UNKNOWN_STATUS, MISSING_CARTON, ORPHAN_ITEM,
INVALID_DATE, INVALID_SPECIAL_RATE, CONFLICTING_IDENTITY, INVALID_PAYMENT, UNEXPECTED_CURRENCY, OVERPAYMENT, DUPLICATE_CONTAINER,
INVALID_SHIPPING_MARK, INVALID_CARTON, UNSAFE_CONTENT, OVERSIZED_FIELD, DUPLICATE_SOURCE_ID, INVOICE_QUARANTINED, PARENT_QUARANTINED,
DB_REJECTED, DB_CONSTRAINT_VIOLATION, SOURCE_CHANGED, …`. Rules: groups of conflicting records (duplicate mark/e-mail/reference/source id)
are quarantined **together** — the importer never picks a winner; a child of a quarantined parent is quarantined (cascade to a fixed
point), so no placeholder parent is ever created; a record the database itself rejects (constraint, trigger, exclusion) is isolated in a
savepoint and quarantined with the SQLSTATE and constraint name, without aborting the batch.

## 8. Idempotency, resume and failure recovery (implemented, tested locally)

* **Identity:** `import_records` is unique on `(source table, source id)` and on `(target table, target id)`. A record and its mapping
  are written in the **same transaction**; a crash leaves both or neither.
* **Second run of the same snapshot** imports nothing, creates no duplicate customer, invoice, payment, container, carton, item,
  status event or audit row, and leaves the business data byte-identical (checked by a signature of every imported table).
  A record already imported from *different* content is **not** re-imported and is flagged `SOURCE_CHANGED` (`NOT_READY`).
* **Crash points tested** (an exception injected at each): after warehouses, after customers, inside the 2nd items chunk before commit,
  inside the payments transaction, inside the invoice-lines transaction, after lines, before and after the cancellations, after the audit
  stage. In every case the batch is recorded `failed`, and re-running yields exactly the database of one clean run.
* **A killed process** leaves a `running` batch; the next run holds the importer's advisory lock (so no live importer exists), marks that
  batch `failed (interrupted)` and resumes. **Two concurrent importers:** one runs, the others are refused ("another import is running").
* **Per-invoice sets** (lines; payments with their voids) are all-or-nothing: a rejected member rolls the set back and is reported.
* **Exact state after a failure:** committed chunks stay (each is complete and mapped); the failed chunk is rolled back entirely;
  quarantine rows of a failed run are not written (they are recomputed and written by the run that completes); the failed batch row
  documents the error. Reference counters are seeded only at the end of a run that got that far (the resume does it).
* Imported history carries `actor_type = 'import'`. The payments triggers also emit *derived* invoice status events (reason
  "payment ledger changed", time = import time) — they are import-run artefacts, distinguishable from source events (which carry a
  `legacy_airtable_id`), and reconciled separately.

## 9. Procedures (implemented; the commands were exercised only against the disposable local test database)

```
# 1. dry-run (offline, or read-only against the target); writes nothing; safe to repeat; the report is byte-identical for the same inputs
MOVEZZ_IMPORT_ENVIRONMENT=local [IMPORT_DATABASE_URL=postgres://…@127.0.0.1/…] \
  node scripts/db-import.mjs dry-run --snapshot snapshots/x.json --report-json reports/x-dryrun.json
# 2. import (needs the importer's signing key; creates a batch; resumable by simply running it again)
MOVEZZ_IMPORT_ENVIRONMENT=local IMPORT_DATABASE_URL=… ACTOR_CONTEXT_KEY=… \
  node scripts/db-import.mjs import --snapshot snapshots/x.json --initiated-by "<who/what>" --report-json reports/x-import.json
# 3. reconcile at any time (read-only): source snapshot vs what is in PostgreSQL now
MOVEZZ_IMPORT_ENVIRONMENT=local IMPORT_DATABASE_URL=… node scripts/db-import.mjs reconcile --snapshot snapshots/x.json
```
Exit codes: `0` READY / READY_WITH_REVIEW, `2` NOT_READY, `1` refused or failed. Reports are written with `wx` (never overwrite) and only
inside the working directory. The URL, keys and credentials are never printed. Committed synthetic fixtures:
`tests/fixtures/migration/synthetic-{clean,messy}.json` (regenerated by `node tests/fixtures/migration/generate.mjs`; a test fails on drift).

## 10. Reconciliation and readiness (implemented, tested locally)

Not just counts. After an import the target is compared with the validated source by: per-table **counts** (mapped rows *and* that the
mapped row exists), the exact **sets of source ids**, a deterministic **content fingerprint** per table (customers, containers, cartons, items,
invoices incl. derived status and paid, payments, lines, status events), **money** (Σ invoice GHS, Σ completed payments, Σ outstanding,
cancelled count) and an **independent per-invoice re-derivation** (`total − completed payments = balance`, status), **integrity** queries
(payments vs `amount_paid`, completed payments on cancelled invoices, lines vs subtotal, cancelled invoices still holding items, cross-customer
links, mappings without rows and rows without mappings) and **side-effect** checks (no users, no Keepup sync rows, no queued
notifications, no history attributed to a user, no record created by a user). Nothing is repaired; every difference is reported.

Verdicts — `READY`: nothing quarantined, nothing to review, no discrepancy, and (scope `target`) everything reconciles; `READY_WITH_REVIEW`:
every check passes and nothing financial/identity/database-related is unresolved, but records were excluded for other reasons or carry
warnings; `NOT_READY`: any failed check, financial or identity problem, database rejection, source/target discrepancy, source/claims
disagreement, structural problem in the snapshot or failed environment check. A dry-run's `READY` has scope `source` ("the source is
importable"); only an import + reconciliation yields scope `target`. Deferred identity records do not change the verdict but are always
reported (they are a cutover prerequisite, not a data defect). Tested: clean synthetic data → `READY` (45/45 checks), messy → `NOT_READY`.

## 11. Production safety (implemented, tested locally)

`env-guard.mjs` fails closed and its decision is part of every report. The importer runs only if **all** hold: an explicit mode; an explicit
`MOVEZZ_IMPORT_ENVIRONMENT` of `test|local|staging`; `NODE_ENV` is not `production`; **no** live-integration variable is present
(`AIRTABLE_*, FIREBASE_*, KEEPUP_*, CLOUDINARY_*, CLOUDFLARE_*, CF_*, RESEND_*, WHATSAPP_*, GOOGLE_APPLICATION_CREDENTIALS`; names only are reported);
the target host is loopback or explicitly allow-listed for `staging`; neither host nor database name contains `prod|production|live`;
a real `export` snapshot is accepted only in `staging` with `MOVEZZ_IMPORT_ALLOW_EXPORT=1`. Refusal happens **before any connection** (tested with a pool that fails if used).
No production host or credential is hard-coded. The importer has no Airtable, Firebase, Keepup, Cloudinary or HTTP client (a test inspects its
source); tests run it with `fetch` replaced by a function that fails, and with a deep-frozen snapshot, proving it neither reaches the network
nor modifies its source. The read-only modes open a READ ONLY transaction and, from the CLI, a read-only session.

## 12. Security review of the importer

| # | Finding | Fix / status | Test |
|---|---|---|---|
| 1 | Unexpected source fields were preserved verbatim; a field named like `auth_uid`/`token` would copy an identity or secret into `legacy_data` | values of identity/secret-looking field names are never preserved | import-security |
| 2 | The id pattern accepted `__proto__` as a record id | reserved names rejected as ids | import-unit/security |
| 3 | The snapshot fingerprint depended on file order for duplicate ids | ties ordered by content | import-unit |
| 4 | The import actor could not record a historical cancellation (0013 allows only super_admin) | 0016 allows the **signed import actor** to cancel **non-native** invoices only; native cancel unchanged | import-security |
| 5 | A mid-transaction rollback left stale in-memory mappings | mapping journal undone on rollback | crash/resume tests |
| 6 | Cancelled-with-payment / overpayment / duplicate payment could be imported "as is" | quarantined with the whole invoice | import-unit |

Reviewed with tests: SQL injection (all values parameterised; hostile names stored literally, identifiers/marks that look like SQL are
rejected), path traversal and symlink escape, malicious JSON (prototype keys, control chars, deep nesting, huge values and lists, bulk 4 000-record
snapshot processed in bounded time), actor spoofing (wrong key → nothing written; assertions are single-use), role/ownership escalation through
fields or links (cross-customer item/line/payment references quarantine the invoice), duplicate/colliding source ids, replay and partial imports,
the runtime role's total lack of access to the import tables, and production-environment refusal.
**Residual risks:** the owner-level import role (see §1); a holder of `ACTOR_CONTEXT_KEY` can mint an import actor — use a key reserved for the migration and
retire it afterwards (`movezz_sec.retire_actor_key`); the importer reads the whole snapshot into memory (bounded by the limits above; a streaming
reader is deferred); per-record savepoints make an import of very large tables slower than bulk COPY (acceptable for a one-off migration, unmeasured on real volumes).

## 13. Cutover prerequisites and open questions (nothing below is decided or verified)

**Requires business decision**
1. How to obtain the **verified financial snapshot** (§6): Keepup export (which fields, what proves the FX), or an explicit decision to import
   Airtable orders as `legacy_ambiguous` with a stated currency convention. Without one of them every invoice is quarantined.
2. Historical **payments**: Airtable has none; confirm Keepup payment data as the source and how voids/reversals are represented.
3. Users: confirm "not imported, re-activate through registration" (and how existing customers are matched to a new login).
4. Package tier for imported cartons (the customer's current package is used and marked), and whether quarantined records may be resolved by
   editing the snapshot (a corrected snapshot is a *new* snapshot with a new fingerprint) or by a separate repair tool (not built).
5. Cancellation reason for legacy cancelled orders when none was recorded (a fixed legacy sentence is used) and whether to accept the
   StatusHistory timestamp as the cancellation time (done when the verified snapshot has none).

**Requires production verification** — the real Airtable field names/shapes (the mapping follows `src/lib/airtable.ts` and is untested on real
exports); that `Orders.Items` and `Items.Order` agree in real data; the real volume and duration; Keepup's behaviour for historical sales.

**Deferred** — a dedicated least-privilege import role; streaming snapshot reader; a repair/resolution tool for quarantined records; importing
pending registrations; Cloudinary/attachment verification of photo URLs; a rehearsal on a staging copy (D21: extract → … → rehearse → explicit
cutover approval); enabling workers/Keepup/notifications; DNS, Firebase and environment switches (7J).

---

# Phase 7J — Staging rehearsal, real-shape validation, cutover readiness

Label legend: **VL** verified locally · **VS** verified in staging (a disposable local PostgreSQL stands in; no shared staging environment exists) ·
**SCD** source-code derived (NOT production validation) · **RPV** requires production verification · **BDR** business decision required · **CO** cutover only.

## 14. Source-shape validation (SCD)
* `tests/fixtures/migration/source-shape.mjs` parses `src/lib/airtable.ts` (mappers and literal create/update keys) into a per-table census of the fields the application
  reads and writes. `tests/fixtures/migration/realistic.mjs` generates a deterministic snapshot from it (`scale`, `seed`) and **throws if it drifts from the census**.
* Modelled Airtable behaviour: empty values omitted; links/lookups as arrays; attachments with thumbnails; a ghost warehouse id; deleted-customer items; history of deleted items;
  carton members that sometimes span containers; staff formula fields; legacy package names; numeric strings; float noise; 3-decimal dimensions; duplicate customer/container/special-rate
  names; an item with two order links; malformed dates; invalid numbers; orders never "Cancelled".
* Findings: `Customers.CreatedBy` was unknown to the importer (now carried into `legacy_data`); float noise (`0.1+0.2`) is normalised to 15 significant digits before decimal checks;
  more than 2 decimals on a dimension is quarantined, not rounded.
* **Financial fail-closed under realistic data (VL):** with no `Verified*` supplement, all 90 orders (both "amount is GHS" and "amount is USD" conventions) are quarantined; no currency,
  FX, discount, total or payment is guessed; the quarantined id sets are identical under both conventions. With a consistent `Verified*` stand-in (test data only) the invoices import.
* Limits: this is not production validation. Real field names/shapes, precision, volume and referential quality are **RPV**.

## 15. Staging rehearsal (VS, disposable local PostgreSQL 16, mocks only)
Reproduce (nothing here touches a live system; the guard refuses live-integration env vars and non-local hosts):
```
scripts/db-local.sh start
MOVEZZ_IMPORT_ENVIRONMENT=local ACTOR_CONTEXT_KEY=<fresh base64 32-byte key, not a production key> \
MOVEZZ_REHEARSAL_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres \
node scripts/staging-rehearsal.mjs --scale 1,2,5,10 --verified none --repeat 2
```
Each cycle: generate snapshot → create `mvz_rehearsal_*` DB → migrate (16/16) → dry-run (writes nothing) → import → reconcile → duplicate import (0 new) → `pg_dump -Fc` (actor signing keys excluded)
→ restore into a new DB → verify migrations, signature equality and reconciliation → drop. Only databases named `mvz_rehearsal_*` are ever dropped.

| scale | items | orders | snapshot | import | rec/s | peak RSS | max tx | reconcile |
|---|---|---|---|---|---|---|---|---|
| 1x | 400 | 90 | 0.7 MB | 1.9 s | 483 | 95 MB | 433 ms | 44/44 |
| 2x | 800 | 180 | 1.3 MB | 3.6 s | 535 | 119 MB | 430 ms | 44/44 |
| 5x | 2000 | 450 | 3.3 MB | 7.7 s | 616 | 185 MB | 347 ms | 44/44 |
| 10x | 4000 | 900 | 6.7 MB | 13.0 s | 731 | 248 MB | 343 ms | 44/44 |

Memory grows roughly linearly (whole snapshot in memory) and is safe at these sizes; streaming is not built. **The real volume is unknown (RPV)** — no production-scale claim is made.
Import exits 2 / verdict NOT_READY in every rehearsal because every order is quarantined for the missing verified financials: that is the correct fail-closed outcome.
Also verified (VL): resume after a crash, replay, duplicate import, quarantine of cross-record problems, rollback of a failed record, backup contents, restore fidelity (`databaseSignature` equal), reconcile on the restored DB.

## 16. Authentication / authorization rehearsal on imported data (VL, Firebase mocked)
Chain tested: mocked Firebase token → Movezz user → signed actor → authorization → ownership (RLS) → operation, for super_admin, warehouse_staff, customer; plus inactive user, inactive customer
(and that reactivating a customer does **not** reactivate its login), unknown uid, invalid token, forged role/customer headers (ignored), forged/stale/expired/other-user assertions (MV007),
cross-site cookie POST (403), wrong-customer reads (null/empty). **Finding:** imported customers have no login (users are not imported) and registration refuses them (MV015); the only path is an
explicit `admin_create_user` by a super_admin with a verified Firebase uid. **BDR / blocks production cutover.**

## 17. Observability (VL)
`src/lib/db/log.ts` and `scripts/lib/import/log.mjs` emit one JSON line per event (only with a sink or `MOVEZZ_LOG=json`), with a stable `correlationId` (request id / batch id / `keepup:`/`outbox:` id) and
redaction of secret-like keys and personal fields (email, phone, name, payload). Events: `import.started/stage/completed/failed/record_rejected/slow_transaction`, `actor.rejected`, `authorization.denied`,
`operation.rejected`, `db.transaction_failed`, `route.rejected/failed`, `keepup.*`, `outbox.*`. Tested for presence, correlation ids and absence of secrets.

## 18. Backup and recovery (VL)
Backup → drop → restore → verify (schema 16/16, record signature, reconciliation) passes. **Finding:** a plain dump contains `movezz_sec.actor_keys` (the HMAC signing keys); the rehearsal excludes the
table data, and the restored DB has no keys (a new key must be provisioned before any actor can act). A real backup must therefore be encrypted or exclude that table. Production backup tooling/inspectability is **RPV / CO**.

## 19. Decision classification (no answers invented)
| # | Item | Classification |
|---|---|---|
| B1 | Verified invoice financials source (subtotal, discount, FX, GHS total) | **BDR — blocks production cutover** (also blocks any staging run that needs invoices; staging runs with test stand-ins only) |
| B1b | Historical payments source | **BDR — blocks production cutover** |
| B2 | Historical logins not imported | **BDR — blocks production cutover**; new finding: customer↔login linking process required (§16) |
| B3a | Tier shown on derived legacy cartons | can remain unresolved for staging; BDR before cutover (display only, marked as derived) |
| B3b | Cancellation reason/time when the source has none | can remain unresolved; cancelled invoices are unrecoverable from Airtable (orders are never "Cancelled") — BDR |
| B4 | Quarantine resolution process | can remain unresolved for staging; blocks production cutover (no repair tool exists) |

## 20. Rollback readiness
Application: redeploy the previous build (documented, not executed). Database: forward-only migrations; recovery is restore-from-backup into a new database. Data: the import is additive and traceable
(`import_records`); Airtable remains untouched and authoritative until explicit cutover approval. Integrations: workers are mock-only and disabled by default. DNS: documented only (`docs/CUTOVER-CHECKLIST.md`), **CO**.

## 21. Remaining risks
Only 4 routes are PostgreSQL-backed; all others are still Airtable-only (the application is not ready to run on PostgreSQL). Real data shape/volume (RPV). Owner-level import role. Whole-snapshot memory.
Signing-key residual risk: see `docs/DECISIONS.md` Addendum C.

## 22. Phase 7K — quarantine resolution (VL)
`node scripts/db-quarantine.mjs list|summary|resolve` (same environment guard as the importer; reads use a read-only session). `resolve --id N --resolution excluded|corrected_in_new_snapshot --reason "..." --resolved-by LABEL [--new-snapshot SHA256]` records one append-only decision in `import_quarantine_resolutions` (migration 0017); a second decision for the same row, an update or a delete is refused by the database, and the runtime role has no access. A "correction" only points to a new snapshot, which goes through the full importer. See `docs/CUTOVER-CHECKLIST.md`.
