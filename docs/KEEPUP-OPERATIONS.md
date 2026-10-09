# Keepup synchronisation — operations (PostgreSQL mode)

Evidence legend used throughout: **LOCAL** = implemented and tested on a disposable local database · **FAKE** = tested against a fake gateway or a local stub HTTP server (no real Keepup) · **STAGING** = verified in a deployed staging environment · **BLOCKED** = needs credentials, a provider contract or an owner decision. **Nothing in this file has STAGING or real-Keepup evidence.**

## 1. What is synchronised
| Movezz event | Keepup call (contract = the live client `src/lib/keepup.ts`) | Row kind | Status |
|---|---|---|---|
| Invoice issued | `POST /sales/add` | `invoice` | LOCAL + FAKE (since 7H) |
| Payment recorded in Movezz (source ≠ `keepup`) | `PUT /sales/balance/{sale}` `{amount_paid, payment_type:"bank_transfer", date, alert_customer:"yes"}` | `payment` | LOCAL + FAKE (migration 0019) |
| Invoice cancelled in Movezz, sale exists | `PUT /sales/cancel/{sale}` `{alert_customer:"no"}` | `cancel` | LOCAL + FAKE (migration 0019) |
| Payment voided before it was sent | nothing is sent; the row is `cancelled` | — | LOCAL |
| Payment voided after it was sent | **no Keepup call exists for this**; the row becomes `needs_reconciliation` ("reverse it in Keepup manually") | — | LOCAL; manual by design |
| Invoice edited | not applicable: issued invoices are immutable in Movezz (the live client's `PUT /sales/edit` has no Movezz event to carry) | — | n/a |
| Refund | no Movezz event maps to Keepup's refund; not implemented, not invented | — | BLOCKED (owner/provider semantics) |
| Payments made in Keepup itself | not read back (no webhook or polling is assumed or built) | — | BLOCKED (provider contract) |

Parity notes taken from the live client, not new decisions: payments are sent as `bank_transfer` whatever the Movezz method was; `alert_customer:"yes"` makes Keepup message the customer in addition to Movezz's own e-mail (the live system behaves the same way); no reference or idempotency value can be put into a payment request, so a payment sits in Keepup without a Movezz reference. The payment date is the Movezz payment's UTC date (the live client sends "today"). Each is an owner decision to keep or change.

## 2. State machine (all kinds share it)
`pending → creating (lease) → synced | failed | needs_reconciliation`; `failed → pending` after back-off (30 s · 2ⁿ⁻¹, capped 1 h, `max_attempts` 5; then parked until a person retries); `needs_reconciliation` is left **only** by a person (`keepup_resolve` for sales, `keepup_op_resolve` for payments/cancels: `applied | not_applied | abandoned`, reason required, audited, super_admin only).
* **Never re-sent automatically:** any ambiguous outcome (timeout, network error, 5xx, 429, redirect, unreadable answer, a lease that expired, a worker that died after claiming). Keepup documents no idempotency key and no lookup by reference, so a re-send could create a duplicate sale or apply a payment twice. LOCAL + FAKE.
* **Definite failures** (HTTP 400/401/403/404/422) are assumed to mean "nothing applied" and are retried within the bound — an assumption about Keepup that is **BLOCKED** until verified against the real API (e.g. a second cancel of a cancelled sale may answer 4xx, which then parks as `failed`).
* **Ordering (payments/cancels):** nothing is sent before the invoice's sale exists; one operation in flight per invoice; payments in creation order, and an unresolved or failed earlier payment blocks later ones; a cancel waits until every payment operation of that invoice is settled. LOCAL (+ 4 parallel workers).
* **Lease safety:** a claimed row is only sent while its lease can still cover the call (lease − 5 s ≥ time already spent + call timeout). Otherwise it is **not sent** and recorded as a retryable failure, so the reaper cannot park a row as "unknown" while a late request is still going out. LOCAL (fake clock).
* **Crash windows:** before claim — nothing happened; after claim, before the call — lease expires → `needs_reconciliation` (never `pending`); after the call, before recording — same; a late success with the right lease token is accepted (evidence is kept). A payment voided while its call was in flight is recorded as `needs_reconciliation`, never `synced`. LOCAL + FAKE.

## 3. Running the worker
Exists: `scripts/keepup-worker.mjs --once` (strict database-target guard; refuses `live` mode and any `http-production` gateway at execution time; `mock` needs `--allow-mock`; prints counts only). One pass = reap expired leases → claim ≤ 5 sale creations → send → claim ≤ 5 payment/cancel operations → send. Verified against a local stub (sale, payment, cancel exactly once; ambiguous not re-sent). **FAKE.**

**No production scheduler exists and none was added.** Options, from what the repository and platform actually offer:
| Option | Facts from the repository | Verdict |
|---|---|---|
| Cron inside the live Pages project | `scripts/cf-pages-deploy.mjs` generates a `_worker.js` with only a `fetch` handler; `wrangler.toml` is a Pages project. Cloudflare Pages has no Cron Triggers (platform fact to confirm in the Cloudflare docs/dashboard; not verifiable from this repository) | not available |
| Separate Cloudflare Worker with a Cron Trigger | `wrangler.staging.toml` already shows a Worker (not Pages) deployment of the app bundle. A scheduler Worker would import the worker module and use `pg` from the Workers runtime — the same unproven path as G2 — and needs a new entry file and wrangler config (a production configuration change) | candidate; **BLOCKED** on G2 and on approval; needs a deployed-staging run first |
| External scheduler running the CLI against the database | the CLI exists; the repository's guards deliberately refuse production targets (runbook G10), so this works for staging today and needs the approved production mode for production | candidate for staging rehearsal; production **BLOCKED** (G10) |
| Cloudflare Queues / Durable Objects | nothing in the repository uses them; would be new, unverified runtime assumptions | not proposed |

**Recommended design once approved (a proposal, not a configuration):** run a pass every minute; any number of overlapping runners is safe (row leases with `SKIP LOCKED`; four concurrent runners tested) so a slow pass never needs a global lock; 5 + 5 rows per pass is ~10 Keepup calls/min per runner (raise `batch`, ≤ 50, if the backlog needs it); lease 120 s, call timeout 20 s (the worker refuses configurations where the timeout is not at least 5 s below the lease); the reaper runs at the start of every pass, so a dead worker's rows are parked within one lease period of the next pass.

## 4. Monitoring and alerts (to be wired by the operator)
Source: the token-gated `GET /api/ready` report now carries a `backlog` object with counts only (`pending`, `creating`, `failed`, `failedExhausted`, `needsReconciliation`, `oldestDueSeconds`); `scripts/keepup-worker.mjs` prints per-pass counts; structured log events `keepup.synced`, `keepup.outcome_unknown`, `keepup.sync_failed`, `keepup.op_*`, `keepup.not_sent_lease`, `keepup.lease_expired`, `keepup.op_record_failed`. Suggested alert thresholds — **owner/operator decisions, not implemented anywhere**:
* `needsReconciliation > 0` → page (a person must check Keepup; money or duplicate sales may be involved)
* `failedExhausted > 0` → page (retries are over)
* `oldestDueSeconds > 600` → warn (no worker is running, or Keepup is down); `> 3600` → page
* `keepup.op_record_failed` or `keepup.outcome_unknown` events → warn
The readiness `backlog` is informational: it never makes the deployment "not ready".

## 5. Readiness and the waiver
`ready` requires, among the database/signing-key checks, `keepup_live_configured` — true only for `MOVEZZ_KEEPUP_MODE=live` with `MOVEZZ_KEEPUP_ALLOW_PRODUCTION=true`; a mock or sandbox never satisfies it and configuration is never treated as verified connectivity (`providerConnectivityVerified` is always `false`). `MOVEZZ_KEEPUP_REQUIRED=false` waives the requirement; the detailed report then lists the waiver under `waivers` and marks `keepup.waived: true`. A waiver is an explicit owner decision (runbook G9), never a success, and nothing in the repository sets it.

## 6. What is still needed before this can be called operational
1. Owner decision G9 (waive for a defined period, or approve the live path).
2. A Keepup account/sandbox and the key, to verify against the real API: the success/rejection classification, the sale response fields, whether a repeated cancel or payment is rejected, whether `amount_paid` is a delta in GHS as the live client assumes, and rate limits.
3. A deployed-staging run of the worker (scheduler option chosen, connectivity from the chosen runtime).
4. The reconciliation procedure rehearsed with a person using the real Keepup UI.
5. Owner decisions on the parity notes in §1 (customer alerts, payment type, no reference).
