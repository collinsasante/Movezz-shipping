# Route migration to PostgreSQL (Phase 7L)

Selection: `MOVEZZ_DATA_BACKEND=postgres` (default and production today: Airtable). One backend per deployment, no silent fallback: an unknown value throws, and with `postgres`
any Airtable access throws (`getBase()`), so a request can never mix sources. Every Airtable route keeps its code; its first line dispatches to `src/lib/pg-routes/*`.
Shared auth (`requireAuth`) is backend-aware (`pgAuthContext`). Required for the PostgreSQL backend: `DATABASE_URL` (runtime role), `ACTOR_CONTEXT_KEY` (random, ≥32 bytes), `DATABASE_SSL=true` in production.
Labels: VL verified locally (real route handlers + PostgreSQL, Firebase/e-mail mocked) · RPV requires production verification.

**Totals: 43 routes · 34 PostgreSQL-backed (each VL) · 9 never touched Airtable (health, upload/sign, auth/signup, auth/reset-password, customers/me/warehouse, onboard, auth/activate, admin/registrations ×2; the first two now authenticate through PostgreSQL) · 0 Airtable-only · 0 deferred · 0 dead.**

| Group | Routes | Roles (database-enforced) | Notes |
|---|---|---|---|
| A auth/users/customers | auth/verify, verify-cookie, users, users/[id], customers, customers/[id] | users & customer admin: super_admin; customers read: staff+admin; customer: own record, address/notes only | unknown identity → 404 `NOT_REGISTERED` (no e-mail claiming); deactivate instead of delete; admins only via `scripts/db-bootstrap-admin.mjs` |
| B operations | items, items/[id], status, history, sorting, cartons, cartons/[n], containers, containers/[id], items, status, sync-items | staff+admin; containers create/edit/status: super_admin; customers: own items/history | prices from `item_authoritative_price`/`package_rates` only; global `PMX-CON-YYYY-NNN` counter; advance-only cascade; invoiced items/cartons frozen |
| C configuration | package-rates, special-rates(+id), settings, warehouses(+id), suppliers(+id) | super_admin writes | rates versioned (close + open), cards retired not deleted, FX = new `fx_rates` row |
| D/E money | orders, orders/[id], create-invoice, keepup-sync | super_admin (customers read own; **staff none**, D6) | invoice service does pricing/FX/discount/locking/idempotency; payment in GHS via `recordPayment`; cancel via `cancelInvoice` |
| F reporting | dashboard/admin, dashboard/customer, reports, activity-logs | admin (staff: operational counts only, no money) | USD = invoice totals (net of discount), GHS = amounts received/owed; never added; no re-valuation |

## Deliberate differences from the Airtable behaviour (each is a locked decision or a safety correction)
1. Warehouse staff cannot read orders/invoices or money (D6). Staff dashboards show zeros for money, as before.
2. `POST /api/users` can create only `warehouse_staff` (super_admin is bootstrap-only, D9); `DELETE` deactivates (history is kept; the Firebase login is not deleted).
3. No first-login e-mail claiming of a customer record; unknown identities get 404 `NOT_REGISTERED`. An inactive customer/user is 401 on data routes (403 `ACCOUNT_INACTIVE` on sign-in).
4. Orders: client `invoiceAmount` is ignored (server prices); `PATCH` cannot change amount/discount/items/date of an issued invoice (409); `DELETE` = cancellation (reason from body, else a fixed sentence); items in a carton must be invoiced with their whole carton.
5. `create-invoice` reports the Keepup synchronisation state (202 while queued) instead of calling Keepup; `keepup-sync` has nothing to pull (PostgreSQL is the ledger); clearing links is refused. Real Keepup stays a controlled cutover activity.
6. A per-customer `exchangeRate` is refused (central FX only); `shippingRatePerCbm` is no longer stored (prices come from package rates); a package rate of 0 means "no rate" and pricing then refuses.
7. Ids are UUIDs and references (`ITM-`, `ORD-`, `CTN-`, `PMX-CON-`) come from database counters. WhatsApp welcome messages are not sent (deferred to the outbox worker); e-mails are sent after commit, best effort, as before.

## Still not done (honest list)
* RPV: Workers → PostgreSQL connectivity; a staging run on a real export; the frontend was not exercised against PostgreSQL in a browser (API contracts are covered by route tests).
* Business decisions B1/B1b/B2 (see `docs/CUTOVER-CHECKLIST.md`); customer-login linking and production backups/keys are cutover actions.
* `Idempotency-Key` header is honoured on order/payment/cancel routes; the current UI does not send it (a double-click is still stopped by the database: items cannot be invoiced twice, overpayment is refused).
