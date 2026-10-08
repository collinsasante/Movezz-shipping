# Movezz Shipping

Freight-forwarding management app for De-MOVEZZ LOGISTICS: warehouse receiving, containers, repacking (cartons),
invoicing through Keepup, and customer tracking. Next.js 16 / React 19 / TypeScript, Airtable (being replaced by
PostgreSQL), Firebase Auth, Cloudinary, Resend.

- Deployment notes (legacy): [DEPLOYMENT.md](DEPLOYMENT.md) - Airtable layout (partly stale): [AIRTABLE_SCHEMA.md](AIRTABLE_SCHEMA.md)

## Testing

```bash
npm ci
npm test               # runs the full suite in a few seconds; no credentials or network needed
npm run test:watch
npm run test:coverage
npm run type-check
```

- The suite is a **characterization baseline**: it records what the application does today, including behavior known to be wrong
  (labelled `KNOWN BUG`). See [docs/CHARACTERIZATION-BASELINE.md](docs/CHARACTERIZATION-BASELINE.md).
- **External services are mocked.** Airtable, Keepup, Firebase, Cloudinary, Resend and WhatsApp are replaced by in-memory
  stand-ins, `fetch` is blocked, and only fake `test-only-...` credentials are used.
  **Tests must never contact production.**
- How the harness works and how to add tests: [tests/README.md](tests/README.md).

`npm run lint` runs ESLint 9 with a flat config (errors fail CI; existing warnings are listed in
[docs/SECURITY-BASELINE.md](docs/SECURITY-BASELINE.md)). To create the first administrator use
`npm run admin:bootstrap` (see DEPLOYMENT.md); there is no built-in account. Security status and open items:
[docs/SECURITY-BASELINE.md](docs/SECURITY-BASELINE.md). Secret scan: `gitleaks git --log-opts="--all" --redact=100`.

## PostgreSQL foundation (Phase 6)

The target database schema, migrations and integration tests live in `db/` and `tests/db/`; the application still runs
on Airtable. Local: `scripts/db-local.sh start`, `MOVEZZ_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres npm run test:db`.
Design, money model, special rates, security and open questions: [docs/DATABASE-ARCHITECTURE.md](docs/DATABASE-ARCHITECTURE.md).
