// Airtable exporter: fixture-based tests against a fake Airtable REST server. No network, no real data, no credentials.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createAirtableReader, runExport, checkLinks, ExportError } from "../../scripts/lib/export/export.mjs";
import { verifyExport } from "../../scripts/lib/export/verify.mjs";
import { assertDestination } from "../../scripts/lib/export/destination.mjs";
import { AIRTABLE_TABLES, parseSnapshotText, snapshotFingerprint } from "../../scripts/lib/import/snapshot.mjs";

type Rec = { id: string; createdTime?: string; fields: Record<string, unknown> };
const BASE = "appTESTBASE000001"; const TOKEN = "patTESTTOKEN.secretsecretsecret";
const rid = (p: string, n: number) => `rec${p}${String(n).padStart(8, "0")}`;

function dataset(customers = 250): Record<string, Rec[]> {
  const t: Record<string, Rec[]> = Object.fromEntries(AIRTABLE_TABLES.map((n) => [n, []]));
  for (let i = 1; i <= customers; i++) t.Customers.push({ id: rid("C", i), createdTime: "2026-01-01T00:00:00.000Z", fields: { Name: `Cust ${i}`, ShippingMark: `MOVEZZ-T${i}` } });
  t.Containers.push({ id: rid("K", 1), fields: { ContainerID: "PMX-CON-2026-001", Items: [rid("I", 1)] } });
  t.Items.push({ id: rid("I", 1), fields: { ItemRef: "ITM-0001", Customer: [rid("C", 1)], Container: [rid("K", 1)], Order: [rid("O", 1)], Photos: [{ id: "attA", url: "https://v5.airtableusercontent.com/x/y.jpg", filename: "y.jpg", size: 10, type: "image/jpeg" }] } });
  t.Orders.push({ id: rid("O", 1), fields: { OrderRef: "ORD-00001", Customer: [rid("C", 1)], Items: [rid("I", 1)] } });
  t.Warehouses.push({ id: rid("W", 1), fields: { Name: "WH" } });
  return t;
}
type Script = { onCall?: (n: number, table: string, offset?: string) => Response | Error | undefined };
function fakeAirtable(data: Record<string, Rec[]>, script: Script = {}, pageSize = 100) {
  const calls: { table: string; offset?: string; auth: string | null; method: string }[] = []; let n = 0;
  const fetchImpl = (async (input: unknown, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(String(input)); const table = decodeURIComponent(u.pathname.split("/").pop()!); const offset = u.searchParams.get("offset") ?? undefined;
    calls.push({ table, offset, auth: init.headers?.Authorization ?? null, method: init.method ?? "GET" }); n++;
    const s = script.onCall?.(n, table, offset); if (s instanceof Error) throw s; if (s) return s;
    if (!(table in data)) return new Response("{}", { status: 404 });
    const start = offset ? Number(offset.replace("itr", "")) : 0; const recs = data[table].slice(start, start + pageSize);
    const body: { records: Rec[]; offset?: string } = { records: recs.map((r) => ({ createdTime: "2026-01-01T00:00:00.000Z", ...r })) };
    if (start + pageSize < data[table].length) body.offset = `itr${start + pageSize}`;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const sleeps: number[] = [];
const reader = (f: typeof fetch, extra: object = {}) => createAirtableReader({ baseId: BASE, token: TOKEN, fetchImpl: f, sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 1, ...extra });
const run = (f: typeof fetch, o: object = {}) => runExport({ reader: reader(f), baseId: BASE, authorizedBy: "Test Owner", ...o });
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof ExportError ? e.code : `ERR:${(e as Error).message}`; } };

describe("pagination and completeness", () => {
  it("reads every page of every table, preserves ids, links, attachments and createdTime, and is read-only", async () => {
    const d = dataset(); const f = fakeAirtable(d);
    const r = await run(f.fetchImpl);
    expect(r.manifest.deterministic.tables.Customers.records).toBe(250);
    expect(r.manifest.run.pages.Customers).toBe(3);
    expect(f.calls.every((c) => c.method === "GET" && c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(f.calls.length).toBe(2 * (3 + 12));                                           // two passes: 3 pages for Customers + 1 per other table
    const snap = JSON.parse(r.text); const item = snap.tables.Items[0];
    expect(item.id).toBe(rid("I", 1)); expect(item.fields.Customer).toEqual([rid("C", 1)]); expect(item.fields.Photos[0]).toMatchObject({ id: "attA", url: expect.stringContaining("airtableusercontent") }); expect(item.createdTime).toBeTruthy();
    expect(Object.keys(snap.tables).sort()).toEqual([...AIRTABLE_TABLES].sort());          // all 13 tables, empty ones included
    expect(r.manifest.deterministic.links.every((l: { missing: number }) => l.missing === 0)).toBe(true);
    expect(JSON.stringify(r.manifest)).not.toContain(TOKEN);
  });
  it("the snapshot is what the importer reads: same fingerprint, and the output is deterministic for the same source", async () => {
    const a = await run(fakeAirtable(dataset()).fetchImpl); const b = await run(fakeAirtable(dataset()).fetchImpl, { label: "other-label" });
    expect(a.manifest.deterministic.fingerprint).toBe(snapshotFingerprint(parseSnapshotText(a.text)));
    expect(b.manifest.deterministic.fingerprint).toBe(a.manifest.deterministic.fingerprint);       // labels/timestamps are not part of the data fingerprint
    expect(JSON.stringify(a.manifest.deterministic)).toBe(JSON.stringify(b.manifest.deterministic));
    expect(JSON.stringify(JSON.parse(a.text).tables)).toBe(JSON.stringify(JSON.parse(b.text).tables));
    const changed = dataset(); changed.Customers[0].fields.Name = "Changed";
    expect((await run(fakeAirtable(changed).fetchImpl)).manifest.deterministic.fingerprint).not.toBe(a.manifest.deterministic.fingerprint);
  });
  it("an empty table is a valid table; a missing table is a hard failure and nothing is produced", async () => {
    expect((await run(fakeAirtable(dataset(2)).fetchImpl)).manifest.deterministic.tables.StatusHistory.records).toBe(0);
    const d = dataset(2); delete (d as Record<string, unknown>).Users;
    expect(await code(run(fakeAirtable(d).fetchImpl))).toBe("TABLE_MISSING");
  });
  it("refuses duplicate ids across pages and a repeating pagination cursor", async () => {
    const d = dataset(150); d.Customers[120] = { ...d.Customers[5] };
    expect(await code(run(fakeAirtable(d).fetchImpl))).toBe("DUPLICATE_ID");
    let n = 0; const looping = (async () => new Response(JSON.stringify({ records: [{ id: rid("C", ++n), fields: {} }], offset: "same" }), { status: 200 })) as unknown as typeof fetch;
    expect(await code(run(looping))).toBe("PAGINATION");
  });
});

describe("retries, rate limits and partial failures", () => {
  it("retries 429 (waits Retry-After / 30 s), 5xx, timeouts and network errors, then succeeds", async () => {
    sleeps.length = 0; const seen = new Set<number>();
    const f = fakeAirtable(dataset(3), { onCall: (n) => {
      if (seen.has(n)) return undefined; seen.add(n);
      if (n === 1) return new Response("{}", { status: 429, headers: { "retry-after": "7" } });
      if (n === 3) return new Response("{}", { status: 429 });
      if (n === 5) return new Response("oops", { status: 503 });
      if (n === 7) return Object.assign(new Error("aborted"), { name: "TimeoutError" });
      if (n === 9) return new Response("not json", { status: 200 });
      return undefined; } });
    const r = await run(f.fetchImpl);
    expect(r.manifest.deterministic.tables.Customers.records).toBe(3);
    expect(r.manifest.run.rateLimited).toBe(2); expect(r.manifest.run.retries).toBeGreaterThanOrEqual(5);
    expect(sleeps).toContain(7000); expect(sleeps).toContain(30000);
  });
  it("gives up after the bounded number of attempts and produces nothing; auth errors fail immediately without retry", async () => {
    const down = fakeAirtable(dataset(3), { onCall: () => new Response("{}", { status: 500 }) });
    expect(await code(run(down.fetchImpl))).toBe("RETRIES_EXHAUSTED"); expect(down.calls.length).toBe(5);
    const denied = fakeAirtable(dataset(3), { onCall: () => new Response("{}", { status: 403 }) });
    expect(await code(run(denied.fetchImpl))).toBe("AUTH"); expect(denied.calls.length).toBe(1);
    const e = await run(denied.fetchImpl).catch((x) => x); expect(String(e.message)).not.toContain(TOKEN);
  });
  it("a failure on a later table fails the WHOLE export (no partial result is returned)", async () => {
    const f = fakeAirtable(dataset(3), { onCall: (_n, table) => (table === "Orders" ? new Response("{}", { status: 422 }) : undefined) });
    const res = await run(f.fetchImpl).then(() => "OK", (e) => (e as ExportError).code); expect(res).toBe("HTTP");
  });
  it("detects a source that changes between passes (not frozen)", async () => {
    const d = dataset(3); let reads = 0;
    const f = fakeAirtable(d, { onCall: (_n, table) => { if (table === "Customers" && ++reads === 2) d.Customers.push({ id: rid("C", 99), fields: { Name: "late" } }); return undefined; } });
    expect(await code(run(f.fetchImpl))).toBe("INCONSISTENT");
    const g = dataset(3); let r2 = 0; const f2 = fakeAirtable(g, { onCall: (_n, table) => { if (table === "Customers" && ++r2 === 2) g.Customers[0].fields.Name = "edited"; return undefined; } });
    expect(await code(run(f2.fetchImpl))).toBe("INCONSISTENT");                       // an edit with the same ids is caught by the content hash
  });
  it("a change in ANY table during the export window is detected (whole-pass comparison), not only within one table's two reads", async () => {
    const d = dataset(3); let customerReads = 0;
    const f = fakeAirtable(d, { onCall: (_n, table) => { if (table === "Customers" && ++customerReads === 2) d.Orders[0].fields.Notes = "edited after pass 1 of every table"; return undefined; } });
    expect(await code(run(f.fetchImpl))).toBe("INCONSISTENT");
  });
  it("requests are paced (minimum interval) and the single-pass option is flagged", async () => {
    const stamps: number[] = []; let t = 0; const f = fakeAirtable(dataset(2), { onCall: () => { stamps.push(t); return undefined; } });
    sleeps.length = 0;
    const rd = createAirtableReader({ baseId: BASE, token: TOKEN, fetchImpl: f.fetchImpl, sleep: async (ms: number) => { t += ms; sleeps.push(ms); }, now: () => t, random: () => 1 });
    const r = await runExport({ reader: rd, baseId: BASE, authorizedBy: "Test Owner", passes: 1 });
    expect(r.manifest.warnings.join(" ")).toMatch(/single pass/);
    expect(stamps.slice(1).every((s, i) => s - stamps[i] >= 0)).toBe(true); expect(sleeps.some((s) => s > 0 && s <= 220)).toBe(true);
  });
});

describe("linked records", () => {
  it("a dangling link fails the export unless explicitly allowed (and is then recorded)", async () => {
    const d = dataset(3); d.Items[0].fields.Customer = ["recMISSING0000001"];
    expect(await code(run(fakeAirtable(d).fetchImpl))).toBe("MISSING_LINKS");
    const ok = await run(fakeAirtable(d).fetchImpl, { allowMissingLinks: true });
    expect(ok.manifest.warnings.join(" ")).toMatch(/dangling/); expect(ok.manifest.deterministic.links.find((l: { table: string; field: string }) => l.table === "Items" && l.field === "Customer")?.missing).toBe(1);
  });
  it("checkLinks covers every link field the importer follows", () => {
    const t = Object.fromEntries(AIRTABLE_TABLES.map((n) => [n, [] as Rec[]])); t.Users.push({ id: "recU1", fields: { CustomerRecord: ["recNope"] } }); t.Containers.push({ id: "recK1", fields: { Items: ["recNope2"] } });
    const bad = checkLinks(t).filter((l) => l.missing); expect(bad.map((l) => `${l.table}.${l.field}`).sort()).toEqual(["Containers.Items", "Users.CustomerRecord"]);
  });
});

describe("independent fingerprint verification", () => {
  it("never verifies without an independently supplied fingerprint, and a mismatch fails", async () => {
    const r = await run(fakeAirtable(dataset(5)).fetchImpl); const m = JSON.stringify(r.manifest);
    for (const bad of [undefined, "", "abc", "Z".repeat(64)]) expect(() => verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: bad as string })).toThrow(/independently supplied/);
    const wrong = verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: "0".repeat(64) });
    expect(wrong.verdict).toBe("FAIL"); expect(wrong.checks.find((c) => /INDEPENDENTLY/.test(c.name))?.ok).toBe(false);
    // a tampered snapshot with its manifest rewritten to match is still caught by the external value
    const t = JSON.parse(r.text); t.tables.Customers[0].fields.Name = "Tampered"; const forged = JSON.parse(m);
    const fp = snapshotFingerprint(parseSnapshotText(JSON.stringify(t))); forged.deterministic.fingerprint = fp;
    expect(verifyExport({ snapshotText: JSON.stringify(t), manifestText: JSON.stringify(forged), expectFingerprint: r.manifest.deterministic.fingerprint }).verdict).toBe("FAIL");
  });
  it("VERIFIED needs the external fingerprint AND external per-table counts; without counts completeness stays unconfirmed", async () => {
    const r = await run(fakeAirtable(dataset(5)).fetchImpl); const m = JSON.stringify(r.manifest); const fp = r.manifest.deterministic.fingerprint;
    const noCounts = verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: fp });
    expect(noCounts.verdict).toBe("FINGERPRINT_VERIFIED_COMPLETENESS_UNCONFIRMED");
    const counts = Object.fromEntries(AIRTABLE_TABLES.map((t) => [t, r.manifest.deterministic.tables[t].records]));
    expect(verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: fp, expectCounts: counts }).verdict).toBe("VERIFIED");
    expect(verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: fp, expectCounts: { ...counts, Customers: 6 } }).verdict).toBe("FAIL");
    const partial = { ...counts }; delete (partial as Record<string, number>).Items;
    expect(verifyExport({ snapshotText: r.text, manifestText: m, expectFingerprint: fp, expectCounts: partial }).verdict).toBe("FAIL");   // counts for some tables only: not a confirmation
  });
  it("detects a missing table, duplicate ids, a manifest that disagrees, and a fixture-kind snapshot", async () => {
    const r = await run(fakeAirtable(dataset(5)).fetchImpl); const fp = r.manifest.deterministic.fingerprint;
    const noTable = JSON.parse(r.text); delete noTable.tables.Users;
    expect(verifyExport({ snapshotText: JSON.stringify(noTable), manifestText: JSON.stringify(r.manifest), expectFingerprint: fp }).ok).toBe(false);
    const dup = JSON.parse(r.text); dup.tables.Customers.push(dup.tables.Customers[0]);
    const v = verifyExport({ snapshotText: JSON.stringify(dup), manifestText: JSON.stringify(r.manifest), expectFingerprint: snapshotFingerprint(parseSnapshotText(JSON.stringify(dup))) });
    expect(v.checks.find((c) => c.name === "no duplicate ids")?.ok).toBe(false);
    const badMan = JSON.parse(JSON.stringify(r.manifest)); badMan.deterministic.tables.Items.records = 99;
    expect(verifyExport({ snapshotText: r.text, manifestText: JSON.stringify(badMan), expectFingerprint: fp }).ok).toBe(false);
    const fixture = JSON.parse(r.text); fixture.source.kind = "fixture";
    expect(verifyExport({ snapshotText: JSON.stringify(fixture), manifestText: JSON.stringify(r.manifest), expectFingerprint: fp }).ok).toBe(false);
  });
});

describe("authorisation, destination and the CLI", () => {
  const SCRIPT = path.join(__dirname, "..", "..", "scripts", "airtable-export.mjs");
  const REPO = path.join(__dirname, "..", "..");
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv });
  const dir = mkdtempSync(path.join(tmpdir(), "exp-"));
  const good = { MOVEZZ_EXPORT_AIRTABLE_TOKEN: TOKEN, MOVEZZ_EXPORT_AIRTABLE_BASE: BASE };
  const args = (over: string[] = []) => ["export", "--authorized-by", "Test Owner", "--confirm-base", BASE, "--out-dir", dir, "--confirm-destination", dir, ...over];
  it("refuses to start without credentials, authorisation, base confirmation or a confirmed destination (before any network use)", () => {
    for (const [name, a, env] of [
      ["no credentials", args(), {}], ["no token", args(), { MOVEZZ_EXPORT_AIRTABLE_BASE: BASE }],
      ["base not confirmed", args().map((x) => (x === BASE ? "appOTHER000000000" : x)), good], ["no authoriser", args().filter((x, i, arr) => x !== "--authorized-by" && arr[i - 1] !== "--authorized-by"), good],
      ["destination not confirmed", args().map((x, i, arr) => (arr[i - 1] === "--confirm-destination" ? "/tmp/else" : x)), good], ["relative destination", ["export", "--authorized-by", "Test Owner", "--confirm-base", BASE, "--out-dir", "rel", "--confirm-destination", "rel"], good],
      ["missing directory", ["export", "--authorized-by", "Test Owner", "--confirm-base", BASE, "--out-dir", path.join(dir, "nope"), "--confirm-destination", path.join(dir, "nope")], good],
      ["inside the repository", ["export", "--authorized-by", "Test Owner", "--confirm-base", BASE, "--out-dir", path.join(REPO, "scripts"), "--confirm-destination", path.join(REPO, "scripts")], good],
      ["single pass", args(["--passes", "1"]), good], ["unknown command", ["wipe"], good],
    ] as [string, string[], Record<string, string>][]) {
      const r = cli(a, env); expect(r.status, name).toBe(1); expect(r.stderr, name).toMatch(/refused or failed/); expect(r.stderr + r.stdout).not.toContain(TOKEN); expect(readdirSync(dir)).toEqual([]);
    }
  });
  it("the destination must be outside any git work tree and is never overwritten", () => {
    const wt = mkdtempSync(path.join(tmpdir(), "wt-")); mkdirSync(path.join(wt, ".git")); mkdirSync(path.join(wt, "out"));
    expect(() => assertDestination(path.join(wt, "out"), path.join(wt, "out"), REPO)).toThrow(/git work tree/);
    expect(() => assertDestination(dir, dir, REPO)).not.toThrow();
  });
  it("refuses a destination writable by group/others, and a symlink that leads into a git work tree", async () => {
    const { chmodSync, symlinkSync } = await import("node:fs");
    const open = mkdtempSync(path.join(tmpdir(), "open-")); chmodSync(open, 0o770);
    expect(() => assertDestination(open, open, REPO)).toThrow(/writable by group or others/);
    const wt = mkdtempSync(path.join(tmpdir(), "wt2-")); mkdirSync(path.join(wt, ".git")); mkdirSync(path.join(wt, "out"), { mode: 0o700 });
    const link = path.join(mkdtempSync(path.join(tmpdir(), "ln-")), "link"); symlinkSync(path.join(wt, "out"), link);
    expect(() => assertDestination(link, link, REPO)).toThrow(/git work tree/);
  });
  it("an existing file or a pre-planted symlink at the target name is never overwritten or followed", async () => {
    const { writeNew } = await import("../../scripts/lib/export/destination.mjs"); const { symlinkSync } = await import("node:fs");
    const victim = path.join(dir, "victim.txt"); writeFileSync(victim, "keep"); const link = path.join(dir, "planted.json"); symlinkSync(victim, link);
    expect(() => writeNew(link, "x")).toThrow(/EEXIST/); expect(readFileSync(victim, "utf8")).toBe("keep");
  });
  it("export files are created new (wx) with mode 0600 and never overwritten", async () => {
    const { writeNew } = await import("../../scripts/lib/export/destination.mjs");
    const f = path.join(dir, "new.json"); writeNew(f, "{}"); expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(() => writeNew(f, "{}")).toThrow(/EEXIST/);
  });
  it("verify (CLI): exit 0 only with the external fingerprint and counts, 3 without counts, 1 on mismatch or when the fingerprint is missing", async () => {
    const r = await run(fakeAirtable(dataset(4)).fetchImpl); const s = path.join(dir, "s.json"); const m = path.join(dir, "m.json");
    writeFileSync(s, r.text); writeFileSync(m, JSON.stringify(r.manifest)); const fp = r.manifest.deterministic.fingerprint;
    const counts = AIRTABLE_TABLES.flatMap((t) => ["--expect-count", `${t}=${r.manifest.deterministic.tables[t].records}`]);
    expect(cli(["verify", "--snapshot", s, "--manifest", m, "--expect-fingerprint", fp, ...counts]).status).toBe(0);
    expect(cli(["verify", "--snapshot", s, "--manifest", m, "--expect-fingerprint", fp]).status).toBe(3);
    expect(cli(["verify", "--snapshot", s, "--manifest", m, "--expect-fingerprint", "1".repeat(64), ...counts]).status).toBe(1);
    const noFp = cli(["verify", "--snapshot", s, "--manifest", m]); expect(noFp.status).toBe(1); expect(noFp.stderr).toMatch(/independently supplied/);
    expect(statSync(s).isFile()).toBe(true);
  });
});
