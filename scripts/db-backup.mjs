#!/usr/bin/env node
// Encrypted backup / verification / restore-to-new-database (see scripts/lib/backup.mjs). Staging or local only.
//   MIGRATION_DATABASE_URL=... MOVEZZ_BACKUP_DIR=/secure/dir MOVEZZ_BACKUP_AGE_RECIPIENT=age1... node scripts/db-backup.mjs backup --confirm-host H --confirm-database D
//   node scripts/db-backup.mjs verify --file F.dump.age --identity ID.txt [--manifest F.manifest.json]
//   MIGRATION_DATABASE_URL=... node scripts/db-backup.mjs restore --file F --identity ID --new-database mvz_restore_xyz --confirm-host H --confirm-database D
import pg from "pg";
import { backup, verifyBackup, restoreToNewDatabase } from "./lib/backup.mjs";

const [cmd] = process.argv.slice(2);
const opt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
try {
  if (cmd === "backup") console.log(JSON.stringify(await backup({ url: process.env.MIGRATION_DATABASE_URL, confirmHost: opt("--confirm-host"), confirmDatabase: opt("--confirm-database"), dir: process.env.MOVEZZ_BACKUP_DIR, recipient: process.env.MOVEZZ_BACKUP_AGE_RECIPIENT }), null, 1));
  else if (cmd === "verify") { const r = await verifyBackup({ file: opt("--file"), identity: opt("--identity"), manifest: opt("--manifest") }); console.log(JSON.stringify(r, null, 1)); process.exitCode = r.verdict === "PASS" ? 0 : 1; }
  else if (cmd === "restore") console.log(JSON.stringify(await restoreToNewDatabase({ url: process.env.MIGRATION_DATABASE_URL, confirmHost: opt("--confirm-host"), confirmDatabase: opt("--confirm-database"), newDatabase: opt("--new-database") ?? "", file: opt("--file"), identity: opt("--identity"), pg }), null, 1));
  else throw new Error("usage: db-backup.mjs <backup|verify|restore> ...");
} catch (e) { console.error(`refused: ${String(e.message).replace(/postgres(ql)?:\/\/\S+/g, "[url]")}`); process.exitCode = 1; }
