# Decisions (authoritative business-rule lock)

**Status: APPROVED.** These 25 decisions were explicitly approved by the product owner at the Phase 6 decision gate,
before any Phase 7 implementation. They are authoritative and **must not be reinterpreted, softened or reopened** by
any engineer or AI session. They can only be changed by a later, explicitly approved ADR that names the decision it
supersedes. If an implementation detail seems to contradict one of them, the implementation is wrong or incomplete:
stop and raise it; do not adjust the rule.

Scope of this file: business rules only. Design and mechanics are in
[DATABASE-ARCHITECTURE.md](DATABASE-ARCHITECTURE.md); the security state is in [SECURITY-BASELINE.md](SECURITY-BASELINE.md).
Record date: Phase 6 decision gate, branch `feature/postgres-foundation`.

Vocabulary: **MUST / MUST NOT** are binding. "Invoice" is the PostgreSQL name for the Airtable "Order".

---

## D1 — Container numbering

* Format stays `PMX-CON-YYYY-NNN`. `YYYY` is the **creation year**.
* `NNN` is a **globally monotonic** sequence. It MUST NOT reset when the year changes.

  ```
  PMX-CON-2026-001
  PMX-CON-2026-002
  PMX-CON-2027-003
  PMX-CON-2027-004
  ```
* Calendar-year-reset numbering MUST NOT be implemented.
* Allocation is transactional and concurrency-safe via the persisted counter; `COUNT(*) + 1` (or any row-count
  derivation) MUST NEVER be used.

## D2 — Invoice financial immutability

Once created, an invoice's **subtotal, discount, total USD, FX rate, total GHS, invoice lines and pricing snapshots**
cannot be edited. To change the financial result: cancel the invoice (history preserved, D3), then create a new
invoice with the corrected values. Historical financial records are never mutated.

## D3 — Invoice cancellation

Cancelling never deletes or rewrites financial data.

* The invoice stays in the database with status **`Cancelled`** (capital C: the authoritative, final spelling, matching
  the existing status convention `Pending / Partial / Paid / Cancelled`; it is NOT renamed to lowercase and no
  migration is needed for capitalization).
* Lines, pricing snapshots, original totals and the original FX snapshot are unchanged.
* Audit history and status history remain.
* Payments are not silently deleted or changed; they can only be corrected through an explicit **void/reversal**, and
  stay auditable.
* Items and cartons that were locked to the invoice MAY become eligible for re-invoicing where appropriate. The
  cancel-and-release operation MUST be **one transaction**, and MUST NEVER make an item or carton available if it has
  since become committed to another valid financial transaction.
* Every cancellation and every release MUST write **status events and audit events**.
* Destructive cancellation is forbidden.

## D4 — Zero-value invoices

Zero-value invoices are **valid** (e.g. subtotal USD 100.00, discount USD 100.00, total USD 0.00, a valid frozen FX
rate, total GHS 0.00, paid GHS 0.00, balance GHS 0.00).

* Such an invoice is considered **financially settled/paid without creating a payment**. A `GHS 0.00` payment record
  MUST NOT be created to make a status work.
* It MUST still have an invoice number, lines, pricing snapshots, an audit trail and status history.

A zero-value **invoice** (reached through an explicit, authorized discount, see D16) is a different thing from a zero
**item price**, which is invalid (D5).

## D5 — Unpriced items

An item cannot be invoiced unless its **authoritative server-side pricing was successfully determined**. If pricing is
missing, invalid, ambiguous or unavailable, invoice creation MUST fail safely. No invented price, **no zero fallback**,
no client-supplied price. The user must resolve pricing first.

**A computed zero price is a pricing failure (final rule).** An item's or carton's authoritative calculated price MUST
NOT be `USD 0.00`. If the calculation yields zero — because the volume/CBM or weight is zero, a rate is missing, a rate
card contains an unintended zero, a special-rate card returns zero, a lookup falls back to zero, or the calculation is
incomplete — that is *invalid pricing*, not a "determined" price. The server MUST reject invoicing until valid pricing
exists. `0.00` is never a valid fallback and never an implicit "free" price. Genuinely free items would need a separate,
explicitly approved business rule; it MUST NOT be inferred from a zero rate. (Zero-value *invoices* via discount, D4, are
unaffected.)

## D6 — Staff permissions

Warehouse staff are **operational** users. They MAY: receive items; manage items and cartons; sort; manage containers;
update operational statuses; view the operational information their work needs.

They MUST NOT administer: package rates, special rates, FX rates, users, roles, **warehouse configuration**, financial
administration, historical payment administration, financial reports/revenue administration.

Authorization is enforced **server-side**; hiding UI controls is never authorization.

## D7 — Customer editing

Customers MAY edit only **address** and **notes**. They MUST NOT directly edit name, phone, e-mail identity, shipping
mark, package tier, rates, special rates, warehouse assignment, financial information, role or account status. Name and
phone changes are **administrative operations**; the shipping mark is regenerated/revalidated from the authoritative
final customer data when appropriate.

## D8 — Inactive customers

Inactive customers cannot log in or use the application. Deactivation is an **access-control state, not deletion**:
invoices, payments, items, cartons, containers, audit records and status events all remain intact.

## D9 — Public registration

```
Registration Request → Admin Review → Approved → Account Activation → Customer Login
```

No automatic administrative privileges for the first registered user. Public registration can never create a
super-admin. Super-admin creation stays an explicit administrative/bootstrap operation.

## D10 — Special rates

Special rates are **optional** and never assumed. Two separate concepts:

1. **Package tier** — a property of the customer (existing tiers; `special` is one of them). Unrelated to cards.
2. **Named special-rate card** — a specific pricing agreement. Denominated in **USD**; optionally belongs to one
   customer, or is **global when `customer_id` is null**; has active flag and effective dates; MUST be **explicitly
   selected by authorized staff**, validated server-side, never selected solely by the client, and never overrides
   normal pricing on its own.

On selection the server MUST verify: (1) the card exists; (2) it is active; (3) it is effective for the relevant date;
(4) it applies to the customer when customer-specific; (5) it applies to the item/rate context; (6) the price is valid — in particular the card's rate for the item's freight type, and the resulting price, are
**greater than zero**.
A special-rate card with a zero effective price is invalid for normal billable items and MUST NOT produce a `special`
billing basis with a zero price (D5). If valid → `billing_basis = special` and the special USD price is frozen onto the item/invoice snapshot. Otherwise →
`billing_basis = tier` with normal package-tier pricing. The system MUST NOT assume a customer has a special rate,
MUST NOT auto-pick the cheapest or highest card, and MUST NOT trust a client-provided `billing_basis` or price.

## D11 — Historical special rates

Do not invent historical customer ownership or validity for cards. Preserve what the Airtable data actually proves
(name, price, item pricing, customer association, validity). Historical records keep their legacy pricing snapshot. If
a relationship cannot be proven: do not fabricate it, preserve the legacy value, **mark the ambiguity**, quarantine
the record where needed, and require manual review where financial correctness depends on it.

## D12 — FX

FX is frozen at invoice creation and stored as the invoice's authoritative snapshot. Historical invoices are NEVER
recalculated with the current rate. Missing FX is an error: never `missing → 1`, never a silent default. Invoice
creation with unavailable FX fails safely.

## D13 — Payments

Pricing is USD; the invoice freezes the USD→GHS conversion; the customer pays in **GHS**; payments are recorded
canonically in GHS with enough information to reconcile against the invoice. Payments are **append-only**; corrections
are void, reversal or explicit reconciliation; payment history is never deleted. **Overpayment is rejected** unless a
future, explicitly approved rule introduces credit handling. Payment concurrency is protected by PostgreSQL
transactions, row locking and idempotency.

## D14 — Keepup

Movezz owns its canonical customers, items, invoices, payments, statuses and financial history. Keepup is an external
invoicing/payment channel and **not** the source of truth. Every Keepup operation is represented locally where
required, with idempotency, sync state, safe retries, failure tracking and reconciliation. An HTTP request being sent
never proves success. Duplicate Keepup sales MUST NOT be created, and Keepup records MUST NOT be created as a side
effect of multiple competing invoice-creation paths.

## D15 — Historical financial data

Historical invoice financials MUST NOT be recalculated with current rates, package pricing, special rates or FX.
Migration preserves legacy values and snapshots. Where reconstruction is required: use **verified** historical Keepup
data; otherwise preserve the Airtable values; mark reconstructed/estimated values; quarantine ambiguous records. Never
silently manufacture historical values.

## D16 — Server-authoritative pricing

The server is the sole pricing authority. The browser may display prices and request a quote; it MUST NEVER decide the
final invoice price. Client-supplied unit price, total, billing basis, **discount**, FX rate, special rate and package
rate are never trusted; the server recalculates and validates all financial values.

**Invoice discounts (final rule).** A discount is financial authority.

* Only **`super_admin`** may grant an invoice discount. Warehouse/operational staff cannot create or modify one.
* The discount is in **USD** and MUST satisfy `0 <= discount_usd <= subtotal_usd`. Negative → rejected. Greater than the
  subtotal → rejected. A 100% discount is allowed when explicitly authorized.
* `subtotal_usd − discount_usd = total_usd`, computed server-side. The client may *request* a discount; its value is
  never authoritative.
* A **non-empty discount reason is mandatory** whenever a discount greater than zero is granted. Missing, empty or
  whitespace-only reasons are rejected. Example: `discount_usd: 100.00`, `discount_reason: "Approved promotional waiver
  by management"`.
* Required server sequence: (1) authenticate the actor; (2) verify `super_admin`; (3) validate the discount; (4) compute
  the final total; (5) require the reason; (6) record the discount **and reason** in the audit history; (7) freeze the
  resulting financial values on the invoice.
* The discount and its reason are part of the immutable invoice record (D2). Changing a discount later means the
  cancel-and-reissue workflow (D2/D3); historical discounts are never edited.


## D17 — Cartons

Cartons are first-class records owning their dimensions, CBM, item association, pricing snapshot, status and invoice
association. CBM is computed authoritatively by the database/backend. Invoiced cartons are financially immutable.
Dissolving a carton MUST NOT erase historical prices or financial information.

## D18 — CBM

CBM is authoritative server/database data, calculated from stored dimensions. Client-calculated CBM is never trusted;
any browser calculation is informational only.

## D19 — Reference numbers

Business references keep their existing user-facing format wherever possible. Allocation is transactional,
concurrency-safe, gap-aware where business semantics require it, and independent of row counts. Counters are persisted
and protected by database transactions. `COUNT(*) + 1` is never used.

## D20 — Deletion

Financial, operational and audit history is not destroyed by ordinary application deletion. Customers: `archived_at`.
Items: archive/deactivate where applicable. Invoices: cancel, never delete. Payments: void/reverse, never delete. Audit
logs and status events: append-only. Historical financial data stays available for reconciliation.

## D21 — Migration safety

Airtable stays untouched during development and migration preparation. Migration must be repeatable, dry-run capable,
auditable, reconcilable, idempotent where possible and safe to rerun. Before production cutover, in order:
extract → transform → validate → reconcile → quarantine ambiguous records → load staging → verify counts → verify
relationships → verify financial totals → verify references → verify attachments → verify customer mappings → verify
historical statuses → rehearse → obtain **explicit cutover approval**. Production Airtable is not modified until the
separately approved cutover phase.

## D22 — Environment separation

Development, staging and production use separate databases, secrets, Firebase configuration (where applicable),
external-integration credentials, storage (where appropriate) and Keepup environments/configuration (where
applicable). Production credentials are never used locally; staging credentials never touch production data; tooling is
never pointed at the production Airtable base by accident.

## D23 — Authentication and authorization

Firebase is responsible for **authentication identity**. Movezz PostgreSQL is responsible for **application
authorization and account state**. Every authorization decision checks: the authenticated identity, the database user,
the role, `is_active`, and customer ownership where applicable. No first-user super-admin promotion; administrative
bootstrap stays explicit.

## D24 — Customer ownership

Customer-facing queries are ownership-scoped **at the database/data-access layer**. A customer can never reach another
customer's items, cartons, invoices, payments, containers, orders or operational data. A missing object and a
non-owned object are indistinguishable: respond `404`, never a status that reveals existence.

## D25 — Auditing

Important mutations MUST produce audit history identifying the actor: customer, item and carton changes; invoice
creation and cancellation; payment creation and void/reversal; pricing changes; special-rate usage; user/role changes;
registration approval; operational status changes; administrative actions. Audit identity comes from the
authenticated server context, never from the browser.

---

## Conformance of the Phase 6 implementation (state at commit `52d0016`)

Recorded so no one has to rediscover it. **No implementation code was changed at this gate.** "Conflict" means the
current Phase 6 PostgreSQL implementation contradicts the decision and must be corrected in the implementation phase;
"Gap" means required behavior is not built yet (the schema does not prevent it).

| # | Item | Class | Detail |
|---|---|---|---|
| D1 | Container sequence | **Conflict** | `allocate_reference('container', <year>)` keeps one counter **per year**, so the sequence restarts each January (`PMX-CON-2027-001`). Required: one global container counter; the year is only printed from the creation date. DATABASE-ARCHITECTURE §8 and the concurrency test that asserts `PMX-CON-2027-001` describe the superseded behavior. |
| D4 | Zero-value invoice status | **Conflict** | `recompute_invoice_payments()` and `createInvoice()` leave a zero-total invoice `Pending` (status needs a payment). Required: such an invoice is settled/paid with no payment record. |
| D3 | Status label | Aligned | `Cancelled` is final and is what the schema already stores. Nothing to change; the earlier lowercase wording was an error and is corrected above. |
| D3 | Release on cancel | Gap | `cancelInvoice()` only flips the status. Items/cartons keep `invoice_id`, so they cannot be re-invoiced; no transactional "release" with its status/audit events and no guard against items that were since committed elsewhere. |
| D5 / D10 | Computed zero price | **Conflict** | `priceItem()` stores a computed `0.00` (zero volume or weight, a missing/zero rate) and accepts a special card whose rate for the freight type is `0` (the column default), yielding a `special` basis at `0.00`; `createInvoice()` only rejects a `NULL` price, so a stored `0.00` is invoiceable. Final rule: a computed zero is a pricing failure; reject at pricing time and at invoicing time. Table constraints (`>= 0`) permit zero and should be tightened (while still allowing legacy imports to be quarantined rather than loaded). |
| D16 | Discount authority and reason | **Conflict / Gap** | `createInvoice()` accepts `discountUsd` from its caller with no role check (only `<= subtotal`), no mandatory reason, and the reason is not stored or audited (`invoices` has no `discount_reason` column; the audit entry records only the amount). Final rule: `super_admin` only, non-empty reason, recorded in the audit history and frozen on the invoice. Needs a schema addition and service change in the implementation phase. |
| D25 | Audit coverage | Gap | Audit/status events exist for invoice creation/cancel, payment create/void. Missing because the services do not exist yet: customer/item/carton changes, `priceItem()` (pricing change and special-rate usage), user/role changes, registration approval, operational status changes. |
| D9 | Activation step | Minor gap | `registration_requests` has `pending/approved/rejected/cancelled`; "Account Activation" is only implied by `resulting_user_id`. No `activated` state or timestamp. |
| D10 | Tier names | Note | The decision's `standard/premium/special` is an example; the schema (correctly) keeps the existing application tiers `basic/business/enterprise/special`. |
| D11 | Ambiguity marker | Gap | Quarantine/"mark the ambiguity" for legacy special-rate data has `legacy_data` but no dedicated flag or quarantine table yet (migration tooling, Phase 7). |
| D6, D7 | Current Airtable app | Gap (code) | Today's Airtable-backed routes still let staff create/edit warehouses and read revenue, and let customers edit name/phone (Phase 5 left these pending Q9/Q10). Both are now decided; they must be changed when the routes move to PostgreSQL. The schema does not obstruct either rule. |
| D2, D5, D12, D13, D14, D15, D17–D20, D22–D24 | — | Aligned | Immutable invoice snapshot; unpriced items rejected; FX frozen and never defaulted; GHS append-only payments, overpayment rejected, void-only correction; Keepup sync-state model with no inline calls; no cascades; generated CBM; carton immutability; append-only history; roles/ownership representable. D24's `404` semantics belong to the (not yet written) repositories. |

Final decisions recorded at the second gate (no open questions remain from the Phase 6 gate):

* `Cancelled` is the authoritative status spelling (D3).
* Zero-value invoices are allowed, only through an explicit authorized discount (D4/D16).
* A computed zero item/carton price is a pricing failure, never a fallback (D5); a zero special-rate price is invalid (D10).
* Only `super_admin` may grant a discount; USD, `0 <= discount <= subtotal`, mandatory reason, server-validated,
  audited, immutable once the invoice exists (D16/D2).

Implementation changes these require (not done at the decision gates): zero-price rejection in pricing and invoicing,
zero-rate rejection for special-rate cards, `discount_reason` storage plus a `super_admin` check and audit of the reason
in invoice creation, plus the items listed as Conflict/Gap above.
