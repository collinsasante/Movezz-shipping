# Cutover checklist (Phase 7J) — NOTHING BELOW HAS BEEN PERFORMED

## MUST PASS (technical)
- [x] VL: migrations 0001–0016 apply to a fresh DB; full PG suite, Airtable suite, tsc, lint, build pass
- [x] VL/VS: dry-run, import, resume, duplicate, reconcile, backup/restore rehearsed on disposable DBs (1x–10x)
- [x] VL: identity → actor → authorization → ownership chain, mocked Firebase
- [ ] RPV: importer run on a real Airtable export in staging; dry-run verdict READY or accepted READY_WITH_REVIEW
- [ ] RPV: real volume/duration measured; production-like staging DB
- [ ] RPV: every remaining Airtable-only route ported to PostgreSQL (or cutover scope explicitly limited)
- [ ] CO: production signing key from a secrets store, separate migration key, retired after import
- [ ] CO: production backups taken, encrypted (or excluding `movezz_sec.actor_keys`), restore tested
- [ ] CO: customer↔login linking executed for every active customer

## BUSINESS APPROVAL REQUIRED
- B1/B1b verified financial and payment source; B2 login handling and linking; B3 cancellation and carton tier; B4 quarantine resolution; written go/no-go; Airtable retained until sign-off.

## PRODUCTION ACTIONS NOT PERFORMED
Production import, migration, DNS change, environment-variable change, Firebase/Keepup/Cloudinary/Cloudflare access, deployment, merge to main, traffic switch, Airtable shutdown. Rollback: redeploy the previous build, repoint DNS (documented only), restore the database from backup, keep Airtable untouched.
