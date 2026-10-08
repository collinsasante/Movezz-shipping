# Characterization baseline

This suite is the safety net for the Airtable -> PostgreSQL rebuild. It records **what the application does today**,
so every later phase can prove it either preserved a behavior or changed it on purpose.

It is **not** a statement that the current behavior is correct. Where behavior is wrong, the test says so explicitly
and names the roadmap phase (numbering from the Phase 3 specification, section J) that must correct it.

## Running it

```bash
npm test               # run once (CI uses this)
npm run test:watch     # re-run on change
npm run test:coverage  # run once with a v8 coverage summary
```

- Needs no environment variables, no credentials and no network. Tests run in about 4 seconds.
- Safe to run anywhere: **tests can never contact production** (see "Safety" below).
- Test order does not matter (verified with shuffled orders).

Current size: **502 tests = 500 passing + 2 `it.todo`** (the Q16 future expectations).

| Folder | Tests | What it covers |
|---|---:|---|
| `tests/unit` | 66 | Pure functions: CBM, shipping marks, reference formats, status order, phone/currency helpers, and the in-memory Airtable stand-in itself |
| `tests/characterization` | 268 | Real route handlers + the real data layer: cartons, pricing, rounding, invoices, payments, status pipeline, containers, items, dashboards/reports, references, reference data |
| `tests/integration` | 22 | The real Keepup HTTP client (stubbed `fetch`) and the real email templates (mocked Resend) |
| `tests/security` | 146 | Authentication, the authorization matrix (every route x every role), IDOR/BOLA, and "what can the client dictate" |

## How it works

- `tests/helpers/fakeAirtable.ts` is an in-memory replacement for the `airtable` package. The **real**
  `src/lib/airtable.ts` and the **real** route handlers run on top of it. It evaluates only the formula constructs the code
  uses and **throws on anything else**, so a changed query fails loudly.
- `tests/helpers/world.ts` builds a fresh application per test (module caches reset, clock fixed at 2026-03-15T10:00:00Z)
  and calls route handlers directly with real `NextRequest` objects (`world.call("items/[id]/status", "PATCH", {...})`).
- Firebase token verification, Keepup, email, Resend and Cloudinary are replaced in `tests/setup/setup.ts`.
- Formulas that live inside React page components (and so cannot be imported) are run from their **real source text**
  (`tests/helpers/sourceFn.ts`) or pinned with a source-text anchor that fails if the code changes.

## Safety: tests never touch production

- `vitest.config.mts` injects obviously fake credentials (`test-only-...`), overriding anything in the developer's shell.
- `tests/setup/setup.ts` replaces `globalThis.fetch` with a function that throws, and replaces every external SDK.
- `tests/security/client-influence.test.ts` asserts that credentials are test-only and that `fetch` is blocked.
- Tests that need the real Keepup/email code load it with `vi.importActual` and stub `fetch` themselves.

## Conventions

| Marker | Meaning |
|---|---|
| `PRESERVE - ...` | Behavior that is correct and must survive the migration unchanged |
| `KNOWN BUG - ...` | **Documents current wrong behavior only.** Replace or invert the test when the named phase fixes it. Never "fix" production code just to make one pass |
| `it.todo("FUTURE ...")` | The intended corrected behavior, recorded so it is not forgotten |

When a fix lands, change the test in the same commit as the fix and say which `KNOWN BUG` it retires.

## Known bugs captured, and the phase that must correct each

127 tests in 69 groups carry the `KNOWN BUG` label. They fall into these themes (phase numbers: Phase 3 roadmap, section J).

| # | Known bug (current behavior) | Test file | Corrected in |
|---|---|---|---|
| 1 | Special-rate items are invoiced at the **tier** price (`pkgEstShipping`), not the special-rate price (`estShippingPrice`). Approved decision Q16: `billing_basis='special'` must bill `special_price_usd` | `pricing` | 7, 9 |
| 2 | A GHS payment is compared with the USD invoice amount; GHS 100 settles a USD 100 (GHS 1,250) invoice | `payments` | 7, 9 |
| 3 | "Mark Paid" records the USD invoice amount against the GHS Keepup sale | `payments` | 9, 10 |
| 4 | The order page multiplies Keepup's already-GHS totals by the exchange rate again; the same field holds GHS or USD depending on whether Keepup answered | `payments` | 7, 9, 15 |
| 5 | No exchange-rate snapshot: historical GHS values move with the global rate; the rate silently defaults to 1 | `invoices`, `payments` | 7 |
| 6 | Payments: lost update on concurrent payments, overpayment accepted, Keepup failure swallowed, no payment email on the UI's payment path, 50%/50% placeholder in the partial-payment email | `payments` | 9, 10, 11 |
| 7 | Keepup lines at order creation use raw USD numbers; the UI then creates a **second** Keepup sale and cancels the first; the customer email carries the cancelled sale's link | `invoices` | 9, 10 |
| 8 | Invoice totals, line distribution, discounts and `Paid` status are accepted from the client; discount > amount accepted; totals unrelated to item prices; ownership/uniqueness of invoiced items unchecked | `invoices`, `client-influence` | 7, 8, 9 |
| 9 | Item prices (`estPrice`, `pkgEstShipping`, special-rate flags) are stored exactly as the client sends them, also for already-invoiced items | `client-influence` | 7, 8 |
| 10 | Browser CBM uses a rounded inch factor; dashboards, container list and customer stats ignore quantity; negative dimensions/quantities are accepted | `pricing`, `dashboard`, `items-containers`, `cbm` | 7 |
| 11 | Revenue ignores discounts and partial payments; "pending revenue" and "outstanding" disagree; customer `pendingPayment` ignores Partial balances | `dashboard` | 7, 9 |
| 12 | `count + 1` references: deleting a record or two simultaneous creations produce **duplicate** ITM/ORD/SUP/PMX-CON/CTN numbers; the container sequence never restarts per year | `references`, `cartons` | 4, 5 |
| 13 | Shipping marks are not unique; name + phone changed together yields a mark from the **old** name; accents are silently dropped | `utils`, `references` | 6 |
| 14 | Cartons: dissolving erases each item's own price; a failed write "rolls back" by erasing prices; edits remove members before validating additions; **invoiced** cartons can still be edited/dissolved; air cartons without weight are priced 0 | `cartons` | 4, 6, 9 |
| 15 | Container cascade overwrites **any** item status (even Completed), writes no history and sends no notification; container/missing changes are not in the history; history failures are silent | `status` | 6, 9, 11 |
| 16 | **First-user bootstrap:** the first Firebase login on an empty Users table becomes `super_admin` (two simultaneous first logins are both promoted) | `authentication` | 8 |
| 17 | Server-generated passwords (`PAKK-xxxxxxxx`, `Math.random`), and `tempPassword` returned in the staff-creation response | `authentication` | 8 |
| 18 | Per-process auth cache keeps demoted/deleted users valid for 5 minutes; no inactive-user concept; raw token errors returned; rate limits per process and spoofable by header; registration endpoints reveal existing emails/phones | `authentication` | 8 |
| 19 | **A customer user with no linked customer record is served every customer's items and orders** | `idor` | 8 |
| 20 | Existence leaks: 403 for another customer's item/order vs 404 for a missing one (500 for history) | `idor` | 8 |
| 21 | Staff can write package rates, special rates and warehouses and read revenue; customers can read every special rate and tier; customers can change their own name/phone (and so their mark). Pending decisions Q9/Q10 | `authorization` | 8 |
| 22 | Package-rate writes are unvalidated (any tier name, negative or non-numeric values); exchange rate has no bounds; `ShippingRatePerCbm` is saved but never used | `client-influence` | 7, 8 |
| 23 | User deletion trusts a client-supplied Firebase UID; the last admin can delete themselves; upload signing accepts any folder and no limits; photo URLs only checked to be URLs | `client-influence` | 8, 12 |
| 24 | Keepup client: any failure retries immediately without the phone (possible duplicate sale); no idempotency key; no timeout; a zero-total sale (100% discount) cannot be read | `keepup-client` | 10 |
| 25 | Invoice and payment emails state USD while the customer pays a GHS Keepup invoice | `email-templates` | 7, 11 |
| 26 | N+1 reads (container load, order load), whole-table scans for every list/dashboard, 60-second per-process customer cache, writes with swallowed second-step failures | several | 5, 6 |
| 27 | Customers receive deactivated warehouses; deleting customers/containers/items leaves dangling references; route comments claim "admin only" where staff are allowed | `reference-data`, `items-containers` | 4, 8 |

## Behaviors confirmed and intentionally preserved

These are `PRESERVE` tests. They must keep passing (or change only with an approved decision):

- The 7 item statuses, their names and order; admin may set any status, staff only move forward; "Shipped to Ghana" requires a container; progress statuses clear the missing flag.
- Sorting: "found" -> Ready for Pickup with history note "Item found during sorting"; "missing" sets the flag only.
- Container statuses and the cascade targets (Shipped -> Shipped; Arrived -> Awaiting Customs Clearance & Duty Process); an item belongs to at most one container.
- CBM = L x W x H / 1,000,000; inches use 16.387064 cm3 per cubic inch; no rounding in the formula.
- Tier rate card defaults in code (350/8, 280/6, 450/12, 500/15) and legacy tier-name mapping; carton pricing = tier rate x carton CBM (sea) or weight (air), total rounded to 2 decimals then split evenly, last item takes the remainder; all carton validation rules and messages.
- Shipping mark format `MOVEZZ-{first initial}{second-word initial}{last 4 phone digits}` and the warehouse address template.
- Reference formats `ITM-0001`, `ORD-00001`, `PMX-CON-YYYY-001`, `CTN-0001`, `SUP-0001`.
- USD invoice -> GHS Keepup conversion rounding (amount x rate to 2 decimals, per-line rounding with the remainder on the last line), line naming and the Keepup payload shape (JSON-string items, E.164 phone, `bank_transfer`, `alert_customer`).
- The role guard of every route (`authz-matrix.ts`), customer data scoping by `customerId`, the response envelope and status codes.

## What this suite cannot verify

| Gap | Why | Mitigation |
|---|---|---|
| Real Airtable schema, formulas, lookups, rollups, automations, select options, inverse-link syncing | The production base is not accessible (Q2 pending). The fake models only what the code itself reads and writes | Re-run against the real schema export once available; keep the fake's limits in mind (see header of `fakeAirtable.ts`) |
| Real Keepup server behavior (idempotency, webhooks, payment listing, currency) | Its documentation host is unreachable from the build environment, and tests never call it | Verify in the Keepup phase (10) with docs or a sandbox account |
| Real Firebase verification, token expiry, disabled-user behavior | Mocked at `verifyIdToken()` | Test with the Firebase emulator or a test project in the auth phase (8) |
| Real Cloudinary uploads, photo access control | No file-serving route exists; photo URLs are public Cloudinary URLs returned inside item JSON | Cover in the file-storage phase (12) |
| Real email/WhatsApp delivery | Mocked; WhatsApp is skipped without credentials | Staging dry-runs (phase 11/18) |
| UI rendering, mobile layouts, accessibility, browser-only logic | No browser tests in this phase. Formulas inside React hooks (`items/new`) are pinned by source anchors only | E2E and accessibility checks in phases 15-17 |
| Concurrency on real Airtable, rate limits across Cloudflare isolates, runtime differences on Workers | The fake is single-process | Re-test on PostgreSQL with real transactions (phases 4-9) |
| Lint | No ESLint config exists and `next lint` was removed in Next 16, so `npm run lint` fails before any code runs. A standard Next config would report ~7 errors (escaped-entity JSX, one unused variable) and ~8 warnings in existing source | Dependency/security baseline phase (2) |

## Maintenance rules

1. A pull request that changes production behavior must update the affected tests in the same commit, retiring the matching `KNOWN BUG` explicitly.
2. A new API route or method needs an entry in `tests/security/authz-matrix.ts` (a completeness test fails otherwise).
3. Keep `fakeAirtable.ts` strict. If a new Airtable formula function is needed, add it there **with a test** instead of loosening the fake.
4. Never place real credentials in tests; use `test-only-...` values.
