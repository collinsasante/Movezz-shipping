# Security baseline (Phase 5)

Branch `feature/security-remediation`, built on the Phase 4 characterization baseline.
Scope: security and integrity fixes that were identified in the audit, plus dependency and lint remediation.
Out of scope (and not done): PostgreSQL, Airtable migration, redesign, deployment, production data changes,
mass dependency upgrades, credential rotation.

**This document does not claim the application is "secure" or "production-ready".** Passing tests show that
specific, listed behaviors were fixed. Each item below says which of these it is:

| Label | Meaning |
|---|---|
| **Fixed** | Changed in code and covered by a regression test that fails without the change |
| **Verified** | Checked and found already correct; a test now pins it |
| **Partially mitigated** | Reduced, with a stated residual risk |
| **Deferred** | Understood and consciously not changed in this phase |
| **Requires production verification** | Cannot be established from the repository or the test environment |
| **Requires architectural work** | Cannot be solved correctly on Airtable; designed for the PostgreSQL phase |

Verification of the tree this document describes is in section 20 and the final report.

---

## 1. Security status

| Area | Status |
|---|---|
| Hard-coded admin credential in source | **Fixed** in code. The credential is still in Git history and must be treated as compromised: **requires rotation by the owner** (section 3) |
| Legacy debug / migration endpoints | **Fixed** (deleted) |
| Authentication (first-user admin, e-mail-claim takeover, token errors) | **Fixed** |
| Customer data isolation (BOLA/IDOR) | **Fixed** and **Verified** by a table-driven probe over every route |
| Staff / admin permissions | **Partially mitigated**: rate-card and special-rate writes are now super_admin only; the remaining differences from the Phase 3 recommendation wait for the owner's answer to Q9 |
| Money / currency | **Partially mitigated**: GHS and USD are never compared or mixed any more; no exchange-rate snapshot exists (**requires architectural work**) |
| Keepup double invoice | **Fixed** (one authoritative creation, idempotent) within the limits of an API with no idempotency key |
| Dependencies | **Partially mitigated**: 0 critical (was 4), 15 high (was 29). The remainder is analysed in section 12 |
| Lint | **Fixed**: a real ESLint 9 check runs; 0 errors, 107 warnings (section 13) |
| Secrets in history | **Verified**: no live secret found except the compromised credential described in section 3 |
| Security headers, cookies, CSRF, redirects | **Partially mitigated** (section 14) |
| Rate limiting | **Partially mitigated** (per isolate only, section 15) |

Production blockers are listed at the end of this document.

---

## 2. Authentication

How it works: the browser signs in with Firebase, the ID token is sent as `Authorization: Bearer` or as the
`auth-token` cookie (`HttpOnly; Secure; SameSite=Strict`, one hour). `requireAuth` verifies the token through
Google's `accounts:lookup`, loads the `Users` row by Firebase UID, and caches the result for 5 minutes per
isolate.

| Finding | Severity | Evidence | Remediation | Test | Blocks production? | Later phase |
|---|---|---|---|---|---|---|
| A-1 First Firebase login on an empty Users table became `super_admin` (two simultaneous first logins were both promoted) | Critical | `api/auth/verify` (removed branch) | Removed. A super admin is created only by the explicit operator command `npm run admin:bootstrap` (hidden password prompt or `--password-stdin`, refuses if a super admin exists, confirmation, audit-log row, never prints the password) | `authentication.test.ts` (first user, simultaneous first users, empty table, customer signup, staff signup, forged role, inactive account, unknown Firebase UID), `bootstrap-admin.test.ts` (23) | No (once the bootstrap is used) | - |
| A-2 Account takeover: a login whose e-mail matched an unlinked customer record was linked to it, verified or not | High | `api/auth/verify` | The e-mail claim now requires `emailVerified === true` from the verified token and a customer with no other Firebase UID | `authentication.test.ts` | No | 8 |
| A-3 Raw token-verification errors returned to the client | Low | `api/auth/verify` | `detail` removed (kept for `NODE_ENV=development` only) | `authentication.test.ts` | No | - |
| A-4 Customer login with no linked customer record was accepted by the middleware layer | High | see B-1 | `requireAuth` denies customers whose profile link is not `ok` (403 `CUSTOMER_NOT_LINKED` / `ACCOUNT_INACTIVE`); the client signs out on those codes | `idor.test.ts`, `customer-boundary.test.ts` | No | - |
| A-5 Initial Firebase passwords were `PAKK-` + 8 characters from `Math.random` (customers, public onboarding) and the staff one was **returned in the API response and shown in the UI** | High | `api/users`, `api/customers`, `api/onboard`, `admin/staff/page.tsx` | All three use `crypto.getRandomValues`, 47 characters, never returned, logged or displayed; the person sets a password through the emailed link. The staff screen now says whether the setup e-mail was sent | `authentication.test.ts` (CSPRNG format, uniqueness, not in response, source anchor) | No | - |
| A-6 Internal error text returned by public/customer-creation endpoints | Low | `api/onboard`, `api/customers` | `detail` only in development | `web-hardening.test.ts` | No | - |
| A-7 5-minute per-isolate auth cache: a demoted or deleted user keeps access until the entry expires; Firebase revocation is not consulted | Medium | `lib/auth.ts` | **Deferred** (documented by KNOWN BUG tests). Shortening it changes Airtable load and needs the session design from the PostgreSQL phase | `authentication.test.ts` (KNOWN BUG) | Accept with the risk noted | 8 |
| A-8 Public `/api/onboard` and `/api/auth/signup` create accounts without e-mail verification or approval and reveal whether an e-mail/phone exists | Medium | `api/onboard`, `api/auth/signup` | **Deferred** (product decision on approval flow) | `authentication.test.ts` (KNOWN BUG) | Owner decision | 8 |

Not changed on purpose: the owner's unmerged branch `origin/feat/signup-password-activation` overlaps these
files (`api/auth/*`, `scripts/`). It must be reconciled with this branch before either is merged; its admin
script generates and prints a password, which contradicts the rule adopted here.

## 3. Hard-coded credential (compromised)

| Item | Detail |
|---|---|
| What | `scripts/create-superadmin.mjs` contained a fixed administrator e-mail and password and printed the password |
| Where in Git | introduced in `210b1ed` (on `main`, 2026-05-15); also present in `19e2286` (owner branch `feat/signup-password-activation`); the deleting commit `4985793` on this branch necessarily contains it in its diff |
| Active? | Unknown. **Treat as active and compromised**: it was in a repository that has been shared and is in history on `main` |
| Remediation done | File deleted; `scripts/bootstrap-admin.mjs` added (no password in source, no generated or predictable password, no automatic promotion, explicit operator action, secure input, audit log). `DEPLOYMENT.md` step 4 rewritten. Nothing was printed or rotated |
| Remediation required from the owner | (1) In Firebase Authentication and the Airtable `Users` table, find that account and **change its password or disable/delete it**. (2) Review `ActivityLogs`/Firebase sign-in logs for logins by it. (3) Do **not** rewrite history to remove it (history rewrite does not un-leak a secret and was ruled out); rotation is the fix. |
| Blocks production? | **Yes, until rotated** |

## 4. Authorization

The approved model is fail-closed, enforced centrally (`requireAuth(request, roles)`), per route (customer
scoping by `user.customerId`) and in the data layer (`getByCustomer` returns `[]` for a missing id).
`tests/security/authz-matrix.ts` lists every route and method with its allowed roles and a completeness test
fails when a route is added without an entry.

| Role | Can |
|---|---|
| `super_admin` | everything |
| `warehouse_staff` | receive/edit items, sorting, cartons, containers (not status), suppliers, warehouses (**Q9 pending**), read reports/exchange rate (**Q9 pending**), trigger the Keepup status sync (**Q9 pending**), forward-only item status |
| `customer` | read their own items/orders/cartons/notifications, change their own name/phone/notes/address and preferred (active) warehouse |

## 5. IDOR / BOLA (ownership boundaries)

Every row was probed with a customer that is not the owner. "404" means identical to a missing record.

| Resource | Boundary | Result |
|---|---|---|
| Customers (`/customers`, `/customers/[id]`, search, `me`) | list/search/write are staff-only; a customer reaches only their own record | Verified |
| Items, item history | scoped by `customerId`; not-owned = 404 (history checks ownership before reading) | **Fixed** (was 403/500 leak) |
| Orders / invoices | scoped by `customerId`; not-owned = 404 | **Fixed** |
| Cartons | staff-only; customers see cartons only through their own items | Verified |
| Payments | recorded only by super_admin; customers see only their own order | Verified |
| Containers | staff only; customers receive only ETA on their own items | Verified |
| Photos | no file-serving route; URLs are inside the owner's item JSON | Verified (see 11) |
| Notifications, activity logs | activity logs staff only; no per-customer feed endpoint | Verified |
| Reports, dashboards | `dashboard/customer` is scoped; reports staff/admin only | Verified |

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| B-1 A customer login with no customer record was served **every** customer's items and orders (an empty `customerId` meant "no filter") | **High** | central `requireAuth` denial, route-level 403, and fail-closed `getByCustomer` | `idor.test.ts`, `customer-boundary.test.ts` (every route, every method) |
| B-2 Existence leak: 403 for another customer's item/order, 404 for a missing one, 500 for history | Medium | both are 404 | `idor.test.ts` |
| B-3 Inactive customer accounts (`Status != active`) kept working | Medium | treated as denied (403 `ACCOUNT_INACTIVE`). **The inactive-customer meaning is an owner decision** (flagged in the final report) | `authentication.test.ts` |

## 6. Customer identity fields

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| C-1 A customer could PATCH their own record and change fields beyond name/phone (package tier, status, shipping mark, e-mail, Firebase UID...) | High | the self-update schema is `.strict()` (name, phone, notes, shippingAddress only); everything else is a 400 | `idor.test.ts` (13+ protected-field attempts) |
| C-2 Preferred warehouse accepted any id | Low | must be an **active** warehouse | `idor.test.ts` |
| C-3 Shipping-mark merge bug: changing name and phone together derived the mark from the **old** name; marks were not unique | Medium | read once, compute from the final name and phone, write once; explicit marks are checked for other holders; derived marks get `-2`, `-3`... suffixes; a repair update covers the Airtable race of two writes | `references.test.ts` (name only, phone only, both, concurrent, collision) |

Customer self-edit of name/phone is still allowed because the owner has not answered **Q10**. It regenerates
the customer's shipping mark, which is what the characterization recorded.

## 7. Role permissions (staff)

Compared with the Phase 3 approved recommendation:

| Power | Before | Now | Status |
|---|---|---|---|
| Write package rates | staff and admin, unvalidated | **super_admin only**, strict schema (four tiers, `{sea, air}` 0-100000) | **Fixed** |
| Write special rates | staff and admin | **super_admin only**, validated | **Fixed** |
| Change exchange rate, users, historical payments | admin only | admin only | **Verified** |
| Bypass customer ownership | impossible for staff by design | pinned | **Verified** |
| Create/edit warehouses | staff and admin | unchanged | **Deferred - Q9** |
| Read revenue reports / dashboard totals / exchange rate | staff and admin | unchanged | **Deferred - Q9** |
| Trigger the Keepup status sync | staff and admin | unchanged | **Deferred - Q9** |
| Comments claiming "admin only" where staff are allowed | wrong | corrected | **Fixed** |

Tests: `staff-permissions.test.ts`, `authorization.test.ts`, `authz-matrix.ts`.

## 8. Input validation

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| D-1 Package-rate writes accepted any tier name, negative or non-numeric values | High | strict `PackageRatesSchema` | `client-influence.test.ts` |
| D-2 Special-rate writes unvalidated | Medium | `SpecialRateSchema` (name 1-100, rates 0-100000) | `reference-data.test.ts` |
| D-3 Discount larger than the invoice accepted and silently clamped to 0 | Medium | 400 (also when the invoice is lowered below an existing discount) | `invoices.test.ts`, `client-influence.test.ts` |
| D-4 Exchange rate had no bounds (0.0001 and 1,000,000,000 accepted) | Medium | 0.1 - 1000 | `client-influence.test.ts` |
| D-5 Order creation accepted items of another customer, already-invoiced items and non-existent items | High | 400 for each | `invoices.test.ts` |
| D-6 `computeCbm` accepts negative dimensions/quantities | Low | **Deferred** (KNOWN BUG tests) | `cbm.test.ts` |

## 9. Money and currency

Approved model: prices are held in **USD**; the customer pays in **GHS**; the Keepup invoice and every payment
are GHS; USD and GHS are never added or compared.

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| E-1 A GHS payment was compared with the USD invoice (GHS 100 settled USD 100 = GHS 1,250) | High | `lib/money.ts`: net = (invoice - discount) x rate, one conversion, one rounding, compared with GHS payments only | `payments.test.ts` |
| E-2 "Mark Paid" recorded the USD amount against the GHS Keepup sale (and ignored earlier payments) | High | records the GHS **outstanding** amount and stores `AmountPaid`/`BalanceDue` in GHS | `payments.test.ts` |
| E-3 The order page multiplied Keepup's GHS totals by the rate again; the same field held GHS or USD depending on whether Keepup answered | High | `GET /api/orders/[id]` returns GHS only (`invoiceTotalGhs`, Keepup values, or `null`); the page no longer multiplies | `payments.test.ts` (incl. source anchors) |
| E-4 Missing exchange rate silently defaulted to 1 | High | `settingsApi.getRate()` returns null; create-invoice and payments answer 409 | `invoices.test.ts`, `payments.test.ts` |
| E-5 Overpayment accepted; concurrent payments overwrote each other | Medium | overpayment is 400; payments for one order are serialised in-process (`lib/locks.ts`) | `payments.test.ts` |
| E-6 Keepup payment failure silently swallowed | Medium | payment is saved and the response carries a `warnings` entry | `payments.test.ts` |
| E-7 Payment e-mails keyed off the requested status, USD amounts, a 50/50 placeholder for partial payments | Medium | e-mails follow the effective status and the real GHS figures; `currency` parameter; no invented split | `payments.test.ts`, `email-templates.test.ts` |
| E-8 The client could supply the line split (`itemPriceMap`) | Medium | ignored; weights come from stored item prices | `invoices.test.ts` |

**Not fixed - requires architectural work.** The order stores no exchange rate or GHS total, so GHS figures are
derived from the **current** global rate: changing the rate changes what an existing invoice is worth and what a
payment settles. This cannot be fixed without adding fields to the production Airtable schema (not verifiable
here). Requirements for the PostgreSQL phase: the invoice stores `usd_total`, `fx_rate`, `fx_rate_date`,
`ghs_total` at creation; each payment stores `amount_ghs`, `received_at`, method and reference (append-only);
balances are `ghs_total - sum(payments)`; the rate is never read after invoicing; rates have bounds and an
audit trail; GHS rounding is a single documented function.

## 10. Special-rate security

Rule (approved decision Q16): an item that carries an applicable special rate is billed at the **special
price**; any other item is billed at its **tier price**. `lib/pricing.ts` (`billingFor`, `invoiceTotalUsd`) is the
single definition, used by the order screen and by the API.

| Behavior | Result |
|---|---|
| Client forces `isSpecialItem`/`specialRateName`/`specialShippingRate` on item create | 400 unless the **named rate exists**; the stored per-unit rate is taken from the table, not the request |
| Flag without a name, or a name/rate without the flag | 400 |
| `PATCH` tries to set special flags | ignored (not in the schema) |
| Prices of an item that is already on an invoice | frozen (409) |
| Order creation | `invoiceAmount` must equal the server total (+/- 0.01) whenever the items carry prices |
| Customer with no special rates | pure tier pricing, unchanged |
| Rate card edited after an item was priced | the item keeps its stored special price (snapshot is the item itself); historical invoices are not recalculated |

Tests: `pricing.test.ts` (the two Phase 4 `it.todo` tests are now real), `client-influence.test.ts`,
`invoices.test.ts`.

Limits: the Airtable `SpecialRates` table is a list of **named** rate cards with no customer, active flag or
validity dates, so "inactive", "expired" and "non-matching customer" cannot be enforced; **requires
architectural work** (PostgreSQL: `special_rates` with `customer_id`, `active`, `valid_from/to`, and
`billing_basis` + price snapshot on the item line). Item **tier** prices are still stored as the client sends
them (server-side pricing is Phase 7), so a staff member can still enter a wrong price; the invoice now
agrees with what is stored, and prices become immutable once invoiced.

## 11. File uploads

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| F-1 `/api/upload/sign` signed any folder the client asked for (`../../anywhere`) | Medium | only `movezz/<segment>[/...]` folders (default `movezz/items`) | `client-influence.test.ts` |
| F-2 Item photo URLs were only required to be URLs (tracking pixels, any host, `http:`) | Medium | https on Cloudinary, Airtable attachments or Firebase Storage only | `client-influence.test.ts` |
| F-3 Signing was unlimited | Low | 30 per user per minute | `client-influence.test.ts` |
| F-4 File type and size are not part of the signature | Medium | **Requires production verification**: enforce allowed formats and a maximum size on the Cloudinary upload preset / account settings (cannot be set from this repository) | - |

## 12. Dependencies

`npm audit` before: **57 advisories (4 critical, 29 high, 21 moderate, 3 low)**.
After: **26 (0 critical, 15 high, 9 moderate, 2 low)**. `npm audit fix --force` was never run.

Changes (all inspected; after the change: `npm ci` on npm 10, type-check, tests, `next build`, and
`opennextjs-cloudflare build` all pass):

| Package | From | To | Why | Breaking risk |
|---|---|---|---|---|
| next | 16.1.6 | **16.4.0** (`^16.3.8`) | critical: HTTP request smuggling in rewrites, image-cache growth | Minor within 16; build and OpenNext build verified. Smoke-test in a browser/staging before deploy |
| eslint / eslint-config-next | 8.57.1 / 14.2.30 | 9.39.5 / 16.4.0 | `next lint` no longer exists in Next 16; the old stack could not run | Dev only |
| axios | 1.13.6 | 1.20.0 | high: SSRF via NO_PROXY, prototype-pollution gadget | In-range |
| resend | 6.9.3 | 6.32.1 | via svix/uuid | In-range; e-mail is mocked in tests, verify a real send in staging |
| protobufjs, proxy-addr, websocket-driver, @grpc/grpc-js (patch), ws, fast-xml-parser, lodash, form-data, follow-redirects, qs, path-to-regexp, postcss, fast-uri, brace-expansion, browserslist, flatted, js-yaml, nanoid, ... | various | patched in-range | critical/high transitive advisories | In-range refresh only; no downgrades (checked) |

Lock file: generated with npm 11 (`npx npm@11 install --package-lock-only`), **verified reproducible with
`npm ci` on npm 10.9.4** (the version CI and the deploy workflow use through Node 22). Never regenerate it with
`--legacy-peer-deps`.

Remaining high advisories, each analysed:

| Package (chain) | Direct/transitive | Runtime or dev | Vulnerability | Affected code in this app | Exploitable here? | Fix | Breaking risk | Decision |
|---|---|---|---|---|---|---|---|---|
| `firebase` 10.14.1 -> `@firebase/auth`, `/storage`, `/functions`, `/firestore` -> `undici` <=6.28 | direct | runtime (browser bundle) | undici insufficiently-random / decompression chain (Node fetch) | the app imports `firebase/app`, `firebase/auth`, `firebase/storage` in the **browser**; undici is Node-only | Very unlikely: no server-side use of the client SDK | npm offers only `firebase@9.14.0` (a **downgrade**, rejected). Real fix: firebase 11+/13 (major) | High: login, Google sign-in, password reset | **Deferred**, schedule with a browser-tested auth upgrade |
| `@firebase/firestore` -> `@grpc/grpc-js` <=1.13.5 (and `-compat`) | transitive | runtime package, **Firestore is not imported** | malformed message crashes a gRPC server/client | none | No | same as above | - | **Deferred** (not reachable) |
| `tailwindcss` 3.4.x -> `chokidar`/`braces`/`micromatch`/`fast-glob` | direct | **build time** | braces stack exhaustion on deeply nested patterns | Tailwind content globbing runs on our own source at build | No (attacker cannot supply patterns) | Tailwind 4 (major, restyles the app) | High | **Deferred** |
| `eslint-config-next`/`@next/eslint-plugin-next` -> `fast-glob` -> `micromatch`/`braces` | direct | **dev only** | same | lint run | No | would downgrade to 14.2.35 (rejected) | - | **Accepted**, dev only |
| `wrangler` -> `miniflare` -> `sharp` 0.34.5, `ws` 8.18, `undici` 7.18 | direct (dev tooling) | **local emulator / deploy tool, not in the Worker bundle** | libvips CVEs, ws memory, undici | `wrangler dev` / deploy | No for the deployed Worker | wrangler 4.148 pulls `miniflare 5.x-alpha` and a new workerd: a deploy-toolchain change that cannot be validated without deploying | Medium | **Deferred** - needs a deploy-pipeline check |
| `react-email` -> `socket.io` -> `engine.io`/`ws`/`esbuild` | direct | **unused by the app code** (no import in `src/`) | ws, esbuild dev-server file read | none | No | remove the dependency, or upgrade to 6.x (major) | Low | **Deferred** (dependency hygiene) |

Moderate/low: all in the same chains (firebase client SDK, tailwind/postcss-selector-parser, react-email).

## 13. ESLint

`npm run lint` runs `eslint .` with a flat `eslint.config.mjs` (eslint-config-next core-web-vitals +
typescript). Result: **0 errors, 107 warnings**; CI runs it and fails on errors.

- Config migration (done): ESLint 9, flat config, Next 16 plugin set.
- Pre-existing violations fixed because they were errors under the new config: unescaped quotes in JSX (6),
  an empty interface, three `any` casts in `airtable.ts`.
- Pre-existing violations **not** fixed (kept as warnings, behavior-preserving rewrites would change component
  behavior and are not security work): 41 `react-hooks/set-state-in-effect`, 6 `immutability`, 1 `use-memo`
  (new React-Compiler-era rules from `eslint-plugin-react-hooks` 7), 6 `exhaustive-deps`, 43 unused variables,
  5 `no-location-assign-relative-destination`, 2 `<img>` usage. Notable unused variables worth a follow-up:
  several data-layer functions accept an `updatedByEmail` they never record (audit trail gaps), and
  `middleware.ts` has an unused `ROLE_ROUTES`.

## 14. Security headers, cookies, CORS, CSRF, redirects

| Item | Status |
|---|---|
| Session cookie `HttpOnly; Secure; SameSite=Strict; Max-Age=3600` | **Verified** (test pins the attributes) |
| `Strict-Transport-Security: max-age=31536000` | **Fixed** (added; no `includeSubDomains`/`preload`, deliberately) |
| `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | **Verified** present |
| CSRF | SameSite=Strict **plus** new Origin check: a state-changing request authenticated by the **cookie** whose `Origin` is another host is refused (403). Bearer-token requests are exempt (a foreign site cannot attach them). **Fixed** (`lib/csrf.ts`) |
| CORS | no CORS headers are emitted, so cross-origin browser reads are blocked by default. **Verified** |
| Open redirect | login `?redirect=` accepted `/\evil.example` (browsers read it as `//evil.example`). `lib/safe-redirect.ts` accepts same-site paths only. **Fixed** (30 cases) |
| CSP | **Deferred**: two different policies are sent (`next.config.js` and `middleware.ts`), both with `'unsafe-inline'` and `'unsafe-eval'`. A nonce/hash policy needs browser testing against Firebase and Google sign-in and was not changed blindly. Tracked by a KNOWN BUG test |
| VPS hardening (if the VPS target is used) | **Requires production verification** - see the list below |

VPS/edge hardening to apply when the PostgreSQL phase moves hosting: terminate TLS at Cloudflare and accept
origin traffic **only from Cloudflare** (so `cf-connecting-ip` cannot be spoofed); firewall everything except
443 from Cloudflare ranges and SSH from a bastion; run the app as a non-root user under systemd with
`NoNewPrivileges`; no secrets in the repository or shell history, a secrets file readable only by the service
user; automatic security updates; fail2ban or equivalent on SSH; separate PostgreSQL user per environment with
least privilege and no public listener; backups and restore tests; HSTS `includeSubDomains` only after every
subdomain is HTTPS.

## 15. Rate limiting

Implementation is an in-memory counter (`lib/rate-limit.ts`): **per isolate/instance**, so it narrows abuse but
is not a hard guarantee; no Redis was introduced.

| Endpoint | Limit | Where enforced |
|---|---|---|
| `POST /api/auth/verify` | 20/min per client IP | existing, app |
| `POST /api/auth/signup`, `/api/onboard`, `/api/customers`, `/api/auth/reset-password` | existing limits | existing, app |
| `POST /api/upload/sign` | 30/min per user | **new**, app |
| `POST /api/orders/[id]/create-invoice` | 10/min per user | **new**, app |
| `POST /api/orders/keepup-sync` | 6/min per user | **new**, app |
| `GET /api/reports` | 30/min per user | **new**, app |
| Login (Firebase) | Firebase's own throttling | provider |
| All `/api/*` | recommended: Cloudflare rate-limiting rule (e.g. 300/min per IP) and a stricter one on `/api/auth/*` (e.g. 20/min) | **Requires production verification** (Cloudflare dashboard) |

Client-IP limits depend on `cf-connecting-ip`/`x-forwarded-for`, which are trustworthy only when traffic
arrives through Cloudflare. Documented by KNOWN BUG tests.

## 16. Keepup integration

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| G-1 Every order produced **two** Keepup sales: `POST /api/orders` created one in raw USD numbers (and e-mailed its link), then the UI called `create-invoice`, which created a second one and cancelled the first | High | `POST /api/orders` no longer touches Keepup. `create-invoice` is the single authoritative creation: GHS at the configured rate, discount applied, carton grouping, lines weighted by stored prices, correct total/link, one e-mail with the link of the sale that exists | `invoices.test.ts` |
| G-2 Clicking create-invoice twice created two sales | High | idempotent: an order that already has a sale gets it back (`existing: true`) unless `{ regenerate: true }`; concurrent calls are serialised per order in-process | `invoices.test.ts` |
| G-3 A partially paid invoice could be regenerated, cancelling the sale that holds the payments | High | 409 | `invoices.test.ts` |
| G-4 Any failed create (even 5xx) was immediately retried without the phone number (possible duplicate sale); no timeout | Medium | retry only on 400/422 (no sale was created); 20 s timeout; 5xx and network errors are not retried | `keepup-client.test.ts` |
| G-5 A sale with total 0 could not be read (`0` treated as missing) | Low | only unreadable totals are "missing" | `keepup-client.test.ts` |
| G-6 No idempotency key | Medium | **Requires production verification / architectural work**: Keepup documents none (docs host unreachable from the build environment). Duplicate prevention is our own one-sale-per-order rule, which Airtable cannot make atomic across instances. PostgreSQL design: an `invoice_sync` row with a unique `(invoice_id)` and a state machine `pending -> creating -> created / failed`, written **before** the external call, plus a reconciliation job that lists Keepup sales by our reference; never retry a create whose outcome is unknown without checking Keepup first |
| G-7 Zero-value invoices (100% discount) | - | The reader no longer breaks on a zero total. Whether Keepup accepts a zero-price sale, and whether such an order should be `Paid` automatically, is **not decided here** (no evidence): **requires owner decision + production verification** | `invoices.test.ts` (documents the 0-priced line) |
| G-8 Webhooks | - | none are used; status is pulled by `keepup-sync` | - |

Also open: editing `invoiceAmount` after a Keepup invoice exists does not update Keepup (only the date can be
synced); `keepup-sync` only changes `Status`.

## 17. Cartons and container status

| Finding | Severity | Remediation | Test |
|---|---|---|---|
| H-1 Dissolving a carton **erased** each member's price; a failed write "rolled back" by erasing prices | High | the member's own price is snapshotted when it joins (`PreCartonPkgEstShipping`) and restored on dissolve/remove; rollback restores the exact previous state | `cartons.test.ts` |
| H-2 Edits removed members before validating additions | Medium | validate and price first, write after | `cartons.test.ts` |
| H-3 Invoiced cartons could be re-dimensioned, re-priced, dissolved | High | immutable (400) | `cartons.test.ts` |
| H-4 Air cartons without a weight were priced 0 and written to every member | Medium | rejected | `cartons.test.ts` |
| H-5 The price snapshot needs an optional Number field `PreCartonPkgEstShipping` on the Items table | - | **Requires production verification**: the snapshot is always a separate best-effort write, so a base without the field never fails a carton operation but then keeps the old behavior (price cleared on dissolve). Add the field to get the fix | `cartons.test.ts` (both cases; KNOWN BUG documents the dependency) |
| H-6 Carton numbers are reused after dissolve; simultaneous creations get the same number | Medium | **Requires architectural work** (sequences/unique constraints). PostgreSQL transactions will guarantee: the carton row, its member rows and the price recalculation commit atomically or not at all; a unique carton number from a sequence; membership edits and invoicing serialised by row locks; an invoiced carton cannot be modified because the invoice line references it |
| I-1 The container cascade overwrote **any** item status (even Completed) and left no trace | High | advance-only: items already at or beyond the target and items flagged missing are untouched; one `StatusHistory` row per moved item; container status changes are logged too | `status.test.ts` |
| I-2 The cascade sends no customer notification | Low | **Deferred by design** (bulk notifications belong with the notification phase) | `status.test.ts` |

## 18. Warehouse visibility

Inactive warehouses are hidden from customers (`/api/warehouses` returns active only) and cannot be chosen as
preferred warehouse; staff and admin still see them and history is preserved (deactivation never deletes).
Tests: `reference-data.test.ts`, `idor.test.ts`. **Fixed.**

## Other fixed items

- `DELETE /api/users/[id]` deleted the Firebase UID named in the request body (any account) and let the last
  `super_admin` be deleted. Now the UID comes from the Users row, an unknown id is 404, and the last super admin
  is protected. (`client-influence.test.ts`)

## 19. Logging and privacy

- Error responses no longer carry internal messages outside development.
- Secrets are never logged by the new code; the bootstrap script masks the base id and never prints a password.
- **Deferred**: audit trail gaps (several mutating data-layer functions ignore the acting user), no PII
  retention policy, `console.error` of raw upstream messages remains server-side, WhatsApp/e-mail content
  contains customer data (provider-side retention not reviewed). Customer e-mail/phone existence can be probed
  through public registration (A-8).

## Remaining vulnerabilities and accepted risks

| ID | Finding | Severity | Why not fixed | Blocks production? | Phase |
|---|---|---|---|---|---|
| R-1 | Compromised admin credential still valid until rotated | Critical | Rotation is an owner action | **Yes** | now |
| R-2 | No FX snapshot (GHS values move with the rate) | High | needs schema/DB | Yes for accurate finance; accept with monthly reconciliation | 7, 9 |
| R-3 | Tier item prices accepted from the client | High | server-side pricing is Phase 7 | Owner decision | 7 |
| R-4 | No cross-instance atomicity (payments, references, cartons, Keepup creation) | High | Airtable has no transactions | Accept until PostgreSQL | 4-9 |
| R-5 | Firebase client SDK advisories (undici/grpc) | High (nominal) | major upgrade, not reachable | No | dependency phase |
| R-6 | Deploy-tool advisories (wrangler/miniflare/sharp) | High (dev) | toolchain change cannot be validated without deploying | No | deploy phase |
| R-7 | CSP with `unsafe-inline`/`unsafe-eval`, two policies | Medium | needs browser testing | Recommended | 12 |
| R-8 | In-memory rate limits; auth cache 5 min | Medium | no shared store in scope | Add Cloudflare rules | 8 |
| R-9 | Staff powers (Q9), customer self-edit (Q10), inactive-customer meaning | Medium | owner decisions | Owner decision | 8 |
| R-10 | Public registration without verification; account enumeration | Medium | product decision | Owner decision | 8 |
| R-11 | Special-rate customer/validity cannot be represented | Medium | schema | No | 7 |
| R-12 | Orders can be set `Paid` by an admin without a payment; invoice amount editable after invoicing | Low-Medium | admin-only; belongs to the payments redesign | Accept | 9 |
| R-13 | Unpriced items allowed on an order (server total 0 = not checked) | Low-Medium | legacy data | Accept | 7 |
| R-14 | Production Airtable token scope, base permissions, automations, schema | Unknown | Q2 (no production access) | **Verify** | 2 |
| R-15 | Cloudinary type/size limits; Cloudflare WAF/rate rules; Keepup behavior (zero totals, idempotency) | Unknown | outside the repository | **Verify** | - |
| R-16 | Owner's unmerged branch overlaps auth files | Process | - | Reconcile before merge | - |

## Production blockers

1. **Rotate/disable the compromised administrator account** (R-1).
2. Add the optional `PreCartonPkgEstShipping` Number field to the Items table, or accept that dissolving a carton clears the members' prices (H-5).
3. Apply Cloudflare rate-limiting rules and Cloudinary upload restrictions (R-8, R-15).
4. Browser/staging smoke test of the Next 16.1 -> 16.4 upgrade, login (including Google), invoice creation against a Keepup **sandbox**, and one real e-mail (Resend 6.32).
5. Owner decisions on Q9, Q10, inactive customers and public registration (R-9, R-10).
6. Reconcile with the owner's branch `feat/signup-password-activation` before merging either.

Items 1 and 4 are required before this branch is deployed; the rest before the system is relied on for money.

## 20. Verification

See the final report for the commands run against the committed tree: `npm ci`, `npm run type-check`,
`npm run lint`, `npm test`, `npm run test:coverage`, `npm run build`, `npm audit`, a full-history gitleaks scan
(`gitleaks git --log-opts="--all" --redact=100 -c .gitleaks.toml`; no leaks after reviewed allow-listing of
placeholders, test-only values and ignored build output), `git status`, `git diff` and `git diff main -- src`.
