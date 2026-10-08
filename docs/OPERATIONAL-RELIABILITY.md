# Phase 7H — PostgreSQL operational reliability

Status of this document: describes migration `0015_operational_reliability.sql` and the code added in Phase 7H.
Nothing here has been run against, or pointed at, any production system. Every external system is a mock or a local stub.

Legend: **Fixed** (change made + regression test) · **Verified** (existing behaviour, test now covers it) ·
**Partially mitigated** · **Deferred** (needs a decision or a production-side fact) · **Requires production verification**.

## 1. What exists after 7H

| Area | Where |
|---|---|
| Keepup sync state machine, lease, claim/complete/fail/ambiguous/reap/resolve/retry | `db/migrations/0015…sql` (`movezz_sec.keepup_*`), `src/lib/db/workers/keepup-worker.ts`, `src/lib/db/integration-admin.ts` |
| Keepup gateway interface, HTTP adapter (sandbox-guarded), mock | `src/lib/integrations/keepup-gateway.ts` |
| Notification outbox claim/lease/retry/dead-letter/requeue | `movezz_sec.outbox_*`, `src/lib/db/workers/outbox-worker.ts` (`NotificationSender`, `MockNotificationSender`) |
| Idempotency ledger integrity; `voidPayment` idempotency key | trigger `idempotency_zz_ledger_guard`, `src/lib/db/invoices.ts` |
| History authority (who may record which audit/status entries) | `movezz_sec.history_allowed`, `append_audit`, `append_status_event` |
| Fail-closed operational writes | trigger `a0_<table>_requires_actor` on items, cartons, containers, item_photos, invoice_lines |
| Expired-key purge (operator only) | `scripts/db-purge-idempotency.mjs` (+ `scripts/lib/purge-idempotency.mjs`; same strict target guard as migrations; deletes only keys expired before the run started; strict flags) |

The live (Airtable-backed) application and `src/lib/keepup.ts` are untouched. No route was switched to PostgreSQL and no
worker entry point (cron, queue consumer, Cloudflare scheduled handler) was created: wiring a worker to a schedule and to a
real Keepup account is a cutover decision (7I).

## 2. Idempotency audit

Key = `(scope, actor, key)` in `idempotency_keys` (unique index), stored in the **same transaction** as the mutation, so a
failed operation leaves no key behind and a crash before COMMIT is fully retryable.

| Mutation | Mechanism | Replay | Conflict | Concurrency | Status |
|---|---|---|---|---|---|
| Invoice create | ledger `invoice.create` + `invoices.external_idempotency_key` | stored invoice, `replayed: true` | same key, other body → `IDEMPOTENCY_CONFLICT` | duplicates wait on the unique index, then replay (12 parallel → 1 invoice, 1 sync row, 1 outbox row) | Verified |
| Invoice cancel | ledger `invoice.cancel` (optional) + state (`INVOICE_ALREADY_CANCELLED`) + `FOR UPDATE` | stored result | other reason → conflict | concurrent cancels → one release, one audit | Verified |
| Payment create | ledger `payment.create` + `payments.idempotency_key` unique | stored payment | other body → conflict; another actor reusing the key → `DUPLICATE`, no second payment | row lock + overpayment trigger | Verified |
| Payment void | **new** ledger `payment.void` (optional key) + state guard (`completed → voided` once) | stored result, no 2nd event/audit | other reason → conflict | 12 parallel (with and without key) → one void | **Fixed** (was state-only) |
| Registration submit | DB duplicate detection + rate limit, one answer for every case | no duplicate request | – | concurrent submissions → 1 request | Verified (7G) |
| Registration approve / reject / activate | state machine in definer functions (`approved` → returns same customer; activate returns existing login) | idempotent by state | different identity refused | concurrent approvals → 1 customer; concurrent activations → 1 login | Verified (7G) |
| Item/carton status changes | row locks + immutability triggers; **no key** (state-based) | `INVALID_STATE` on a repeat | – | carton race tests | Verified; no client-visible key (deferred to the route phase) |
| Keepup sync | `keepup_sync.idempotency_key = invoice:<id>` unique + one row per invoice + unique sale id + lease token | claim is `SKIP LOCKED`; a completed row is never claimed | stale token → `INVALID_STATE` | 5 workers × 25 invoices → each sent once | **Fixed/New** |
| Notification enqueue | `dedupe_key` unique (`ON CONFLICT` in definer paths) | one row | – | 8 parallel enqueues → 1 row | Verified + new |
| Notification send | lease token; provider idempotency key `outbox:<id>` | at-least-once (see §4) | stale token → `INVALID_STATE` | 4 workers × 40 messages → each once | **New**; duplicate window documented |
| Import operations | **no importer exists** (`legacy_airtable_id` unique indexes already make a re-import reject, not duplicate) | – | – | – | **Deferred (7I)**: needs production Airtable read access |

Ledger integrity (**Fixed**): the application role could previously `UPDATE`/`DELETE` its own ledger rows (re-point
`result_entity_id`, change `request_hash`, delete a completed key). Now only `in_progress → completed|failed` is allowed, no
identity column can change, and `DELETE` is revoked (expiry purge is the operator script).

Known limits: keys are readable by every staff actor (they hold internal ids only; customers cannot read the table). A key's
`response` is a small JSON of ids, never a secret.

## 3. Keepup synchronization

States: `pending → creating → synced | failed | needs_reconciliation`, plus `cancelled` and `not_required` (zero-total, A2).

| From → To | Who / how |
|---|---|
| `pending/failed → creating` | `keepup_claim` (integration/system only). Commits **before** Keepup is contacted |
| `creating → synced` | `keepup_complete` with the attempt's lease token **and** a sale id (CHECK also forbids `synced` without one) |
| `creating → failed` | `keepup_fail`: Keepup definitively refused (400/401/403/404/422) or the request could not be built. Back-off 30 s … 1 h, bounded by `max_attempts` (default 5); after the last attempt no retry is scheduled |
| `creating → needs_reconciliation` | `keepup_ambiguous` (timeout, 5xx, 429, network, 2xx without sale id, unparsable body, redirect) **or** `keepup_reap_expired` (worker died / lease expired) |
| `needs_reconciliation → synced / pending / cancelled` | `keepup_resolve`, **super_admin only**, with a reason, audited. `created` needs the verified sale id; `not_created` is refused until the original lease + 5 min grace is over (an in-flight call must be over) |
| `failed → pending` | `keepup_manual_retry`, super_admin only, reason, audited, adds retry budget |
| `pending/failed → cancelled`, `* → needs_reconciliation` | `cancelInvoice` (direct, allowed by the guard) |

Direct SQL by the runtime role (even a super_admin or the worker identity) can no longer: write `synced`/`creating`, skip
states, change `keepup_sale_id`, `attempt_count`, lease columns, `max_attempts`, `last_success_at`, or re-open a reconciled row.

A late success from the same attempt (lease reaped meanwhile) is accepted, because the worker then holds the real response.
A late success for an invoice cancelled meanwhile is stored as evidence (`keepup_sale_id`) in `needs_reconciliation` with the
instruction to cancel the sale in Keepup — it is **never** reported as synced. A sale id already attached to another invoice
is never attached twice.

### Exact state left by each failure (all tested in `operational-reliability.test.ts`)

| Failure point | Persistent state afterwards | Automatic follow-up |
|---|---|---|
| Process dies **before the claim commits** | `pending`, attempt_count 0 (rolled back) | next pass claims it |
| Dies **after claim, before the request** | `creating`, lease set, 1 attempt, **no request sent** | after lease expiry → `needs_reconciliation` (cannot know it was not sent); **never re-sent** |
| Dies **after the request, before recording** | `creating`, lease set; Keepup may hold the sale | after lease expiry → `needs_reconciliation`; never re-sent |
| Request cannot be built (nothing sent) | `failed`, back-off scheduled | retried when due |
| Keepup rejects (4xx) | `failed`, `last_error`, back-off | retried when due, bounded |
| Timeout / 5xx / garbage after sending | `needs_reconciliation`, `last_error` | none; operator resolves |
| Outcome cannot be written (DB down / lease lost) | stays `creating` | lease expiry → `needs_reconciliation` |
| Database restart during the external call | as "dies after the request" | as above |
| Worker restart | no in-memory state is used; a fresh process continues from the table | – |

Why not retry ambiguous outcomes: Keepup documents no idempotency key and no lookup-by-reference (`docs/SECURITY-BASELINE.md`),
so a blind retry would create duplicate sales (D14). The Movezz reference and idempotency key are written into the sale
notes only as a human aid for reconciliation.

Worker identity: the signed `integration` actor (`ACTOR_CONTEXT_KEY`); `system` is also accepted. Staff, super_admin sessions,
customers, `import` and no-actor sessions get `NOT_AUTHORIZED` from every worker function.

Gateway safety: no ambient secrets are read; the production host (`api.keepup.store`) is refused unless **both**
`environment: "production"` and `allowProduction: true` are passed (a cutover decision); plain http only for a local sandbox
stub; no credentials/query/fragment in the URL; sandbox hosts must be local or named `sandbox|staging|test`; redirects are never
followed; response size is bounded; the API key never appears in an outcome.

## 4. Notification outbox

Enqueue is in the business transaction (invoice creation, registration approval). Direct writes by the application are limited
to enqueue (requires a verified actor, `pending`, 0 attempts, valid recipient, ≤ 16 KiB payload) and cancelling something not
yet sent. `sent`, `dead`, attempts and leases move only through `outbox_*` functions (worker identity); `DELETE` is revoked.

`pending/failed → sending (lease) → sent | failed (back-off 30 s…1 h) | dead` (permanent error or `max_attempts` = 6).
A worker crash leaves `sending`; after the lease the reaper returns it to `failed` (due now) or `dead`.
**Delivery is at-least-once**: a crash after the provider accepted but before `sent` is recorded re-sends the message. The
sender receives `outbox:<id>` as the provider idempotency key. A late success from the old attempt is still accepted if nobody
re-sent yet. `dead` rows are requeued only by a super_admin (`outbox_requeue_dead`, audited).
No real e-mail/WhatsApp adapter was written (it needs provider credentials): the interface and a mock exist.

## 5. Audit and history

Immutability (append-only triggers, no TRUNCATE) was already enforced; 7H adds **authority**:

| Actor | May record audit | May record status events |
|---|---|---|
| super_admin, system, import | any well-formed action | any entity |
| warehouse_staff | `item.* carton.* container.*` on those entities | item, carton, container |
| customer | `customer.update_self` for **its own** customer id only | none |
| integration | `keepup.* notification.*` on keepup_sync/notification/invoice | keepup_sync |
| no actor | none | none |

Fixed: previously any verified actor, including a customer login, could call `append_audit('invoice.cancel', …)` and plant a
false record attributed to itself. Verified: replay of an assertion, deactivated users and archived customers are refused by
`begin_actor` (7C); a forbidden history write rolls the whole business transaction back (tested).

## 6. Operational writes without an actor

Fixed: `items`, `cartons`, `containers`, `item_photos`, `invoice_lines` accepted writes from the runtime role with **no**
verified actor (a leaked `DATABASE_URL` or an SQL injection could change operational data without the signing key). They now
fail with `MV007`. Table owner/superuser (migrations, imports, ops) is unchanged. Existing tests that forged data through the
bare runtime role now do so through a verified actor (same attack, stronger precondition) — see commit message.

## 7. Security findings

| # | Finding | Severity | Result |
|---|---|---|---|
| 1 | Any verified actor (incl. customer) could forge audit/status history | High | Fixed + tests |
| 2 | Runtime role could rewrite/delete idempotency results | High | Fixed + tests |
| 3 | `keepup_sync` could be set `synced` with no sale id / states skipped by a super_admin or the worker identity | High | Fixed + tests |
| 4 | `notification_outbox` writable/deletable by the runtime role, even with no actor | Medium | Fixed + tests |
| 5 | Operational tables writable with no actor (leaked credential) | Medium | Fixed + tests |
| 6 | Cancel vs. Keepup completion could deadlock (lock order) — found by the new race test before shipping | Medium | Fixed (invoice → sync row everywhere) + 20-race test |
| 7 | `updateCustomerAdmin` allow-list used `in` (`constructor`, `__proto__` pass as "fields") → SQL error path | Low | Fixed (`Object.hasOwn`) + test |
| 8 | Legacy `creating`/`sending` rows from before leases would never expire | Low | Fixed (grace-based expiry) + upgrade test |

Reviewed, no change needed: SQL is parameterised everywhere (the one dynamic `SET` list uses an allow-listed column map);
login redirects go through `safeRedirectPath`; the gateway has the SSRF/redirect/host guards above; no webhook endpoints exist
(Keepup webhooks are not assumed — nothing to verify yet); worker/admin functions each check the verified actor in SQL and
via `authorize`; customers cannot read `keepup_sync`, `notification_outbox`, `idempotency_keys` (RLS) or enqueue.

## 8. Not done / remaining risks

* **Deferred to 7I (cutover):** wiring a scheduled worker; a real Keepup client in production mode (requires the production
  key, sale-id reconciliation procedure with real data, and verification of Keepup behaviour: idempotency, lookup by reference,
  zero-value sales, cancellation, payment sync); a real e-mail/WhatsApp sender; the Airtable extract/transform/validate/
  reconcile/quarantine importer and dry-run tooling (needs production Airtable read access); switching routes to PostgreSQL.
* **Keepup payment sync** (`kind = 'payment'`) is not enabled: Movezz is the payments source of truth and Keepup's payment API
  semantics are unverified; the worker only handles invoice sales.
* **Requires production verification:** Keepup response shapes (`sale_id`, `share_link`) match the current live client's
  parsing but were only tested against a stub; that Keepup treats 400/401/403/404/422 as "nothing created".
* **Signing-key residual risk** (7C) is unchanged: code that holds `ACTOR_CONTEXT_KEY` can act as any active user or service
  identity. The worker and the web app should not share a key in production (use `set_actor_key` rotation; documented in §13b).
* In-memory rate limits (`src/lib/rate-limit.ts`) are per instance; registration has a database-enforced throttle; there is no CAPTCHA.
* Back-off timing and `max_attempts` are defaults chosen here, not business rules agreed with the owner.
* Reaping depends on a worker pass running; with no worker scheduled, `creating`/`sending` rows simply wait.


## Phase 7J — Observability (VL)
Structured JSON events (`src/lib/db/log.ts`): `actor.rejected`, `authorization.denied`, `operation.rejected`, `db.transaction_failed`, `route.rejected`, `route.failed`, `keepup.claimed/synced/outcome_unknown/…`, `outbox.claimed/sent/retry_scheduled/…`.
Active only with a sink or `MOVEZZ_LOG=json`. Correlation id = request id (actor events) or `keepup:<id>` / `outbox:<id>`. Secret-like keys and personal fields (email, phone, name, payload) are redacted. Workers were rehearsed with mocks only
(crash/restart, outcome-unknown, retry) and no real notification or Keepup call; they remain disabled by default.
