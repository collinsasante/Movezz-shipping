// Re-hosting Airtable-hosted photos to Cloudinary (scripts/lib/rehost): guard, resumability, no duplicates, auditability, no data loss.
// A fake uploader stands in for Cloudinary; no network, no real credentials, no real data.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe, createTestDb, customer, item, sqlstate, type TestDb } from "./helpers";
import { assertRehostEnvironment, rehostPhotos, rehostReport, safeSource } from "../../scripts/lib/rehost/rehost.mjs";
import { ImportRefusal } from "../../scripts/lib/import/errors.mjs";

const CLOUD = "movezz-staging-test";
const okEnv = (o: Record<string, string | undefined> = {}) => ({ NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test", MOVEZZ_REHOST_CLOUDINARY_URL: `cloudinary://key:secret@${CLOUD}`, MOVEZZ_REHOST_CONFIRM_CLOUD: CLOUD, ...o }) as unknown as NodeJS.ProcessEnv;
const refused = (fn: () => unknown) => { try { fn(); return "OK"; } catch (e) { return e instanceof ImportRefusal ? "REFUSED" : `ERR:${(e as Error).message}`; } };
const AT = "https://v5.airtableusercontent.com/v3/u/1/abc/photo.jpg";

describe("re-host environment guard", () => {
  const url = "postgres://u@127.0.0.1/movezz_dev";
  it("accepts a local target with an explicitly confirmed cloud", () => { expect(assertRehostEnvironment({ env: okEnv(), targetUrl: url, mode: "run" })).toMatchObject({ cloudName: CLOUD, folder: "movezz/items" }); });
  for (const [name, over] of [
    ["no cloud confirmation", { MOVEZZ_REHOST_CONFIRM_CLOUD: undefined }], ["a different cloud confirmed", { MOVEZZ_REHOST_CONFIRM_CLOUD: "other" }],
    ["a production-looking cloud", { MOVEZZ_REHOST_CLOUDINARY_URL: "cloudinary://k:s@movezz-prod", MOVEZZ_REHOST_CONFIRM_CLOUD: "movezz-prod" }],
    ["malformed credentials", { MOVEZZ_REHOST_CLOUDINARY_URL: "nope" }], ["production NODE_ENV", { NODE_ENV: "production" }],
    ["an unapproved environment class", { MOVEZZ_IMPORT_ENVIRONMENT: "production" }], ["an Airtable key", { AIRTABLE_API_KEY: "x" }],
    ["a standard Cloudinary secret", { CLOUDINARY_API_SECRET: "x" }], ["a Keepup key", { KEEPUP_API_KEY: "x" }], ["a path-traversing folder", { MOVEZZ_REHOST_FOLDER: "../x" }],
  ] as [string, Record<string, string | undefined>][])
    it(`refuses ${name}`, () => expect(refused(() => assertRehostEnvironment({ env: okEnv(over), targetUrl: url, mode: "run" }))).toBe("REFUSED"));
  it("refuses a remote database that is not allow-listed and confirmed", () => expect(refused(() => assertRehostEnvironment({ env: okEnv(), targetUrl: "postgres://u@db.example.com/m", mode: "run" }))).toBe("REFUSED"));
  it("plan/report need no Cloudinary credentials", () => expect(assertRehostEnvironment({ env: { NODE_ENV: "test", MOVEZZ_IMPORT_ENVIRONMENT: "test" } as unknown as NodeJS.ProcessEnv, targetUrl: url, mode: "plan" }).cloudName).toBeNull());
  it("only Airtable-hosted https URLs are processed and queries are dropped", () => {
    expect(safeSource(`${AT}?ts=1&signature=SECRET`)).toEqual({ host: "v5.airtableusercontent.com", path: "/v3/u/1/abc/photo.jpg" });
    for (const u of ["http://v5.airtableusercontent.com/a", "https://evil.example/a", "https://x.airtableusercontent.com.evil.example/a", "https://u:p@v5.airtableusercontent.com/a", "not a url"]) expect(safeSource(u)).toBeNull();
  });
});

dbDescribe("photo re-hosting (PostgreSQL)", () => {
  let db: TestDb; let itemId: string;
  const photo = async (url: string, provider = "airtable", sort = 0, legacy: string | null = null) =>
    (await db.admin.query("INSERT INTO item_photos (item_id, storage_provider, url, sort_order, legacy_attachment_id) VALUES ($1,$2,$3,$4,$5) RETURNING id", [itemId, provider, url, sort, legacy])).rows[0].id as string;
  const state = async (id: string) => (await db.admin.query("SELECT * FROM item_photos WHERE id = $1", [id])).rows[0];
  const logs = async () => (await db.admin.query("SELECT * FROM photo_rehost_log ORDER BY id")).rows;
  const uploader = (behave: (url: string, publicId: string) => Promise<unknown> | unknown = () => ({})) => {
    const calls: string[] = []; const store = new Map<string, { publicId: string; url: string }>();
    return { calls, store, cloudName: CLOUD, async upload(src: string, { publicId }: { publicId: string }) {
      calls.push(publicId); await behave(src, publicId);
      const existing = store.get(publicId); if (existing) return { ...existing, width: 800, height: 600, existing: true };   // overwrite=false semantics
      const r = { publicId, url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${publicId}.jpg` }; store.set(publicId, r); return { ...r, width: 800, height: 600 };
    } };
  };
  beforeAll(async () => { db = await createTestDb(); itemId = await item(db.admin, await customer(db.admin)); });
  afterAll(async () => { await db?.close(); });

  it("moves photos in place, keeping item, order and legacy id; skips non-Airtable and unsafe rows; dry run changes nothing", async () => {
    const a = await photo(`${AT}?sig=SECRET1`, "airtable", 0, "att1"), b = await photo(AT + "2", "airtable", 1, "att2");
    const keep = await photo("https://res.cloudinary.com/x/y.jpg", "cloudinary", 2); const other = await photo("https://firebasestorage.googleapis.com/z", "other", 3);
    const plan = await rehostPhotos({ pool: db.admin as never, uploader: uploader(), folder: "movezz/items", dryRun: true });
    expect(plan).toMatchObject({ selected: 2, uploaded: 0, dryRun: true }); expect((await state(a)).storage_provider).toBe("airtable"); expect(await logs()).toHaveLength(0);
    const up = uploader(); const r = await rehostPhotos({ pool: db.admin as never, uploader: up, folder: "movezz/items" });
    expect(r).toMatchObject({ uploaded: 2, failed: 0 });
    for (const [id, sort, legacy] of [[a, 0, "att1"], [b, 1, "att2"]] as const) {
      const s = await state(id);
      expect(s).toMatchObject({ item_id: itemId, storage_provider: "cloudinary", public_id: `movezz/items/${id}`, sort_order: sort, legacy_attachment_id: legacy });
      expect(s.url).toBe(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/movezz/items/${id}.jpg`);
      expect(JSON.stringify(s.metadata)).not.toContain("SECRET1"); expect(s.metadata).toMatchObject({ rehosted_from_host: "v5.airtableusercontent.com" });
    }
    expect((await state(keep)).url).toBe("https://res.cloudinary.com/x/y.jpg"); expect((await state(other)).storage_provider).toBe("other");
    expect(JSON.stringify(await logs())).not.toContain("SECRET1");
    // resumable / idempotent: nothing left to do, no second upload
    const again = uploader(); expect(await rehostPhotos({ pool: db.admin as never, uploader: again, folder: "movezz/items" })).toMatchObject({ selected: 0 }); expect(again.calls).toHaveLength(0);
    const rep = await rehostReport(db.admin as never); expect(rep).toMatchObject({ remainingAirtable: 0, otherProviderNotAutomated: 1, retirementReady: false });
    await db.admin.query("UPDATE item_photos SET archived_at = now() WHERE id = ANY($1::uuid[])", [[a, b, keep, other]]);   // isolate later tests
  });

  it("an expired source is logged and the row is untouched; retries are capped and reported for review", async () => {
    const id = await photo(AT + "-expired"); const before = await state(id);
    const dead = uploader(() => { throw Object.assign(new Error("Error in loading https://v5.airtableusercontent.com/x?sig=TOPSECRET - HTTP status 404"), { httpCode: 400 }); });
    for (let n = 1; n <= 4; n++) await rehostPhotos({ pool: db.admin as never, uploader: dead, folder: "movezz/items", maxAttempts: 2 });
    expect(dead.calls).toHaveLength(2);                                              // capped at max-attempts
    expect(await state(id)).toEqual(before);                                          // never half-migrated, never deleted
    const l = (await logs()).filter((x) => x.photo_id === id);
    expect(l).toHaveLength(2); expect(l[0]).toMatchObject({ outcome: "failed", error_class: "source_inaccessible" }); expect(JSON.stringify(l)).not.toContain("TOPSECRET");
    expect(await rehostReport(db.admin as never, { maxAttempts: 2 })).toMatchObject({ remainingAirtable: 1, retryable: 0, needsReview: [{ photoId: id, failures: 2, lastError: "source_inaccessible" }], retirementReady: false });
    // a later, higher cap (e.g. the source URL was refreshed) retries it and succeeds
    expect(await rehostPhotos({ pool: db.admin as never, uploader: uploader(), folder: "movezz/items", maxAttempts: 3 })).toMatchObject({ uploaded: 1 });
    expect((await state(id)).storage_provider).toBe("cloudinary");
  });

  it("a crash after upload but before the database update cannot create a duplicate asset", async () => {
    const id = await photo(AT + "-crash"); const up = uploader();
    // first attempt: the upload succeeds at the provider but the row update loses the race (simulated by archiving the row meanwhile)
    const first = uploader(async () => { await db.admin.query("UPDATE item_photos SET url = url || 'x' WHERE id = $1", [id]); });
    const r1 = await rehostPhotos({ pool: db.admin as never, uploader: first, folder: "movezz/items" });
    expect(r1).toMatchObject({ uploaded: 0, failed: 1 }); expect(r1.details[0]).toMatchObject({ errorClass: "concurrent_change" });
    expect((await state(id)).storage_provider).toBe("airtable");
    // retry with the SAME deterministic public id and an uploader that already holds the asset -> reused, not duplicated
    up.store.set(`movezz/items/${id}`, { publicId: `movezz/items/${id}`, url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/movezz/items/${id}.jpg` });
    const r2 = await rehostPhotos({ pool: db.admin as never, uploader: up, folder: "movezz/items" });
    expect(r2.details.find((d: { photoId: string }) => d.photoId === id)).toMatchObject({ result: "uploaded_existing_asset" }); expect(up.store.size).toBe(1);
  });

  it("an answer that does not match the requested asset is never applied", async () => {
    const id = await photo(AT + "-bad");
    const bad = { cloudName: CLOUD, async upload() { return { publicId: "someone/elses", url: `https://res.cloudinary.com/${CLOUD}/a.jpg` }; } };
    expect(await rehostPhotos({ pool: db.admin as never, uploader: bad, folder: "movezz/items" })).toMatchObject({ failed: 1 });
    expect((await logs()).filter((x) => x.photo_id === id)[0]).toMatchObject({ error_class: "invalid_response" });
    const wrongCloud = { cloudName: CLOUD, async upload(_s: string, o: { publicId: string }) { return { publicId: o.publicId, url: `https://res.cloudinary.com/another-cloud/${o.publicId}.jpg` }; } };
    expect(await rehostPhotos({ pool: db.admin as never, uploader: wrongCloud, folder: "movezz/items" })).toMatchObject({ failed: 1 });
    expect((await state(id)).storage_provider).toBe("airtable");
    await db.admin.query("UPDATE item_photos SET archived_at = now() WHERE id = $1", [id]);
  });

  it("only one run at a time", async () => {
    const id = await photo(AT + "-lock"); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const slow = uploader(() => gate); const first = rehostPhotos({ pool: db.admin as never, uploader: slow, folder: "movezz/items" });
    await new Promise((r) => setTimeout(r, 200));
    await expect(rehostPhotos({ pool: db.admin as never, uploader: uploader(), folder: "movezz/items" })).rejects.toThrow(/in progress/);
    release(); expect(await first).toMatchObject({ uploaded: 1 }); expect((await state(id)).storage_provider).toBe("cloudinary");
  });

  it("the attempt log is append-only and invisible to the runtime role; rows are never deletable", async () => {
    expect(await sqlstate(db.admin.query("UPDATE photo_rehost_log SET outcome = outcome"))).not.toBe("OK");
    expect(await sqlstate(db.admin.query("DELETE FROM photo_rehost_log"))).not.toBe("OK");
    expect(await sqlstate(db.admin.query("TRUNCATE photo_rehost_log"))).not.toBe("OK");
    expect(await sqlstate(db.app.query("SELECT 1 FROM photo_rehost_log"))).toBe("42501");
    expect(await sqlstate(db.admin.query("DELETE FROM item_photos"))).not.toBe("OK");   // log rows reference photos (RESTRICT)
  });
});
