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

> `npm run lint` is currently broken (Next 16 removed `next lint` and the repo has no ESLint config). It is scheduled for the
> dependency/security baseline phase; see the baseline document.
