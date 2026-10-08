// Encrypted backups and restore checks. Rules (each has a test):
//  - the owner URL is judged by the same strict target guard as migrations (host + exact database + staging class + verified TLS if remote)
//  - the dump is streamed through `age` straight into the destination: no plaintext copy ever touches the disk; the file is created 0600
//    and never overwrites; the destination must exist and be OUTSIDE the repository
//  - only an age PUBLIC recipient is needed to back up; decryption material (the identity) is never read by `backup`
//  - signing keys are excluded (--exclude-table-data=movezz_sec.actor_keys) and `verify` proves their absence in the archive
//  - restores go ONLY into a brand-new database named mvz_restore_* that must not exist yet; the source database is never touched
//  - passwords reach pg_dump/pg_restore through the environment (never argv), and are not printed
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertStagingTarget } from "./migrate.mjs";
import { resolveTarget } from "./target.mjs";

export class BackupRefusal extends Error {}
const RECIPIENT = /^age1[0-9a-z]{50,}$/;
export const RESTORE_PREFIX = "mvz_restore_";

export function pgEnv(url, env = process.env) {
  const u = new URL(url); const t = resolveTarget(url, env);
  return { PATH: env.PATH ?? "", PGHOST: t.host, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: t.database,
    ...(t.local ? {} : { PGSSLMODE: "verify-full" }) };
}
function destination(dir, repoRoot) {
  if (!dir) throw new BackupRefusal("MOVEZZ_BACKUP_DIR is required");
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new BackupRefusal("the backup directory does not exist");
  if (abs === repoRoot || abs.startsWith(repoRoot + path.sep)) throw new BackupRefusal("the backup directory must be outside the repository");
  return abs;
}
const sha256File = async (f) => { const h = createHash("sha256"); await pipeline(createReadStream(f), h); return h.digest("hex"); };
const run = (cmd, args, o = {}) => new Promise((res) => { const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...o }); let out = "", err = ""; c.stdout.on("data", (d) => out += d); c.stderr.on("data", (d) => err += d); c.on("close", (code) => res({ code, out, err })); });

/** @returns {Promise<{file: string, manifest: string, bytes: number, sha256: string}>} */
export async function backup({ url, confirmHost, confirmDatabase, dir, recipient, env = process.env, repoRoot = process.cwd() }) {
  assertStagingTarget({ url, confirmHost, confirmDatabase, env });
  if (!RECIPIENT.test(recipient ?? "")) throw new BackupRefusal("MOVEZZ_BACKUP_AGE_RECIPIENT must be an age public key (age1...)");
  const t = resolveTarget(url, env); const abs = destination(dir, repoRoot);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const final = path.join(abs, `${t.database}-${stamp}-${randomBytes(3).toString("hex")}.dump.age`); const tmp = `${final}.partial`;
  if (existsSync(final)) throw new BackupRefusal("refusing to overwrite an existing backup");
  const dump = spawn("pg_dump", ["-Fc", "--no-owner", "--exclude-table-data=movezz_sec.actor_keys"], { env: pgEnv(url, env), stdio: ["ignore", "pipe", "pipe"] });
  const enc = spawn("age", ["-r", recipient], { stdio: ["pipe", "pipe", "pipe"] });
  let derr = "", eerr = ""; dump.stderr.on("data", (d) => derr += d); enc.stderr.on("data", (d) => eerr += d);
  const out = createWriteStream(tmp, { mode: 0o600, flags: "wx" });
  const codes = await Promise.all([new Promise((r) => dump.on("close", r)), new Promise((r) => enc.on("close", r)), pipeline(dump.stdout, enc.stdin), pipeline(enc.stdout, out)].map((p) => p.catch?.((e) => e) ?? p));
  if (codes[0] !== 0 || codes[1] !== 0) { try { unlinkSync(tmp); } catch { /* nothing written */ } throw new BackupRefusal(`backup failed (pg_dump exit ${codes[0]}, age exit ${codes[1]}): ${(derr + eerr).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 300)}`); }
  renameSync(tmp, final);
  const sha256 = await sha256File(final); const bytes = statSync(final).size;
  const manifest = `${final}.manifest.json`;
  writeFileSync(manifest, JSON.stringify({ file: path.basename(final), sha256, bytes, database: t.database, host: t.host, createdAt: new Date().toISOString(), format: "pg_dump -Fc | age", excludes: ["movezz_sec.actor_keys (data)"], note: "decrypt with the custodian's age identity; provision a NEW actor key after any restore" }, null, 1), { mode: 0o600, flag: "wx" });
  return { file: final, manifest, bytes, sha256 };
}

/** Decrypts with the identity file and returns the archive's table of contents. Nothing is written to disk. */
async function listArchive(file, identity) {
  const dec = spawn("age", ["-d", "-i", identity, file], { stdio: ["ignore", "pipe", "pipe"] });
  const list = spawn("pg_restore", ["--list"], { stdio: ["pipe", "pipe", "pipe"] });
  let toc = "", err = ""; list.stdout.on("data", (d) => toc += d); list.stderr.on("data", (d) => err += d); dec.stderr.on("data", (d) => err += d);
  const codes = await Promise.all([new Promise((r) => dec.on("close", r)), new Promise((r) => list.on("close", r)), pipeline(dec.stdout, list.stdin).catch((e) => e)]);
  return { ok: codes[0] === 0 && codes[1] === 0, toc, err: err.slice(0, 300) };
}
/** @param {{ file: string, identity: string, manifest?: string }} o */
export async function verifyBackup({ file, identity, manifest }) {
  /** @type {{ checksum: boolean|null, decrypts: boolean, hasMigrations: boolean, signingKeyDataAbsent: boolean, verdict?: string }} */
  const res = { checksum: null, decrypts: false, hasMigrations: false, signingKeyDataAbsent: false };
  if (manifest) { const m = JSON.parse((await import("node:fs")).readFileSync(manifest, "utf8")); res.checksum = m.sha256 === await sha256File(file); }
  const { ok, toc } = await listArchive(file, identity);
  res.decrypts = ok; res.hasMigrations = /TABLE DATA public schema_migrations/.test(toc);
  res.signingKeyDataAbsent = ok && !/TABLE DATA movezz_sec actor_keys/.test(toc);
  res.verdict = (res.checksum !== false) && res.decrypts && res.hasMigrations && res.signingKeyDataAbsent ? "PASS" : "FAIL";
  return res;
}

/** Restores into a NEW database only. The caller supplies the owner URL of the SERVER (database part ignored). */
export async function restoreToNewDatabase({ url, confirmHost, confirmDatabase, newDatabase, file, identity, env = process.env, pg }) {
  if (!newDatabase.startsWith(RESTORE_PREFIX) || !/^[a-z0-9_]{1,50}$/.test(newDatabase)) throw new BackupRefusal(`the new database name must match ${RESTORE_PREFIX}[a-z0-9_]*`);
  assertStagingTarget({ url, confirmHost, confirmDatabase, env });   // the URL's database is only the maintenance connection; it must still be named explicitly
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [newDatabase])).rows[0]) throw new BackupRefusal("that database already exists; a restore never overwrites");
    await admin.query(`CREATE DATABASE ${newDatabase}`);
  } finally { await admin.end(); }
  const e = { ...pgEnv(url, env), PGDATABASE: newDatabase };
  const dec = spawn("age", ["-d", "-i", identity, file], { stdio: ["ignore", "pipe", "pipe"] });
  const rest = spawn("pg_restore", ["--no-owner", "--exit-on-error", "-d", newDatabase], { env: e, stdio: ["pipe", "pipe", "pipe"] });
  let err = ""; rest.stderr.on("data", (d) => err += d); dec.stderr.on("data", (d) => err += d);
  const codes = await Promise.all([new Promise((r) => dec.on("close", r)), new Promise((r) => rest.on("close", r)), pipeline(dec.stdout, rest.stdin).catch((x) => x)]);
  if (codes[0] !== 0 || codes[1] !== 0) throw new BackupRefusal(`restore failed; the new database ${newDatabase} was left for inspection: ${err.replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 300)}`);
  return { database: newDatabase, note: "provision a fresh actor key, run db-migrate status and reconciliation before any use" };
}
export const toolsPresent = () => ["pg_dump", "pg_restore", "age"].every((c) => spawnSync(c, ["--version"]).status === 0);
