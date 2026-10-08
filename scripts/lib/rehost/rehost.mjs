// Resumable re-hosting of Airtable-hosted item photos to Cloudinary. Airtable attachment URLs die with the Airtable account, so every
// `item_photos` row with storage_provider = 'airtable' must be moved (or explicitly accepted as lost) before Airtable is retired.
//
// Safety properties (each has a test):
//  - same environment guard as the importer (test/local/staging, loopback or allow-listed host, confirmed DB name, no other integration
//    credentials); Cloudinary credentials come ONLY from MOVEZZ_REHOST_CLOUDINARY_URL and the cloud must be named explicitly
//  - the photo row is UPDATED IN PLACE: item association, sort order and legacy_attachment_id are untouched; nothing is deleted
//  - deterministic Cloudinary public_id (folder/photo-uuid) with overwrite=false: a crash or retry can never create a duplicate upload
//  - a row is only switched after the provider's answer is validated, and only if it still has the URL we read (optimistic check)
//  - failed/expired sources are logged (append-only photo_rehost_log), retried up to --max-attempts, then reported as needing review;
//    the row is left exactly as it was
//  - no query strings (possible signatures) are ever stored or reported; only Airtable-hosted https URLs are processed
import { randomUUID } from "node:crypto";
import { ImportRefusal } from "../import/errors.mjs";
import { evaluateEnvironment } from "../import/env-guard.mjs";

export const AIRTABLE_HOST = /(^|\.)airtableusercontent\.com$/i;
const LOCK_KEY = 7_345_001;   // pg advisory lock: one re-host run at a time

/** Environment guard for the re-host tool. Throws ImportRefusal listing every failed check. Returns { cloudName, folder }. */
export function assertRehostEnvironment({ env = process.env, targetUrl, mode }) {
  const own = {};
  for (const [k, v] of Object.entries(env)) if (!/^MOVEZZ_REHOST_/.test(k)) own[k] = v;
  const d = evaluateEnvironment({ env: own, targetUrl, mode: mode === "run" ? "import" : "reconcile" });
  const failed = d.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  let cloudName = null;
  const folder = env.MOVEZZ_REHOST_FOLDER || "movezz/items";
  if (!/^[a-z0-9][a-z0-9/_-]{0,80}$/i.test(folder) || folder.includes("..")) failed.push("MOVEZZ_REHOST_FOLDER is not a plain folder path");
  if (mode === "run") {
    const raw = env.MOVEZZ_REHOST_CLOUDINARY_URL;
    const m = /^cloudinary:\/\/[^:@\s]+:[^@\s]+@([a-z0-9_-]+)$/i.exec(raw ?? "");
    if (!m) failed.push("MOVEZZ_REHOST_CLOUDINARY_URL must be cloudinary://KEY:SECRET@CLOUD_NAME");
    else {
      cloudName = m[1];
      if (env.MOVEZZ_REHOST_CONFIRM_CLOUD !== cloudName) failed.push("MOVEZZ_REHOST_CONFIRM_CLOUD must equal the Cloudinary cloud name (explicit confirmation of the upload target)");
      if (/(^|[^a-z])(prod|production|live)([^a-z]|$)/i.test(cloudName)) failed.push("the Cloudinary cloud name looks like production");
    }
  }
  if (failed.length) throw new ImportRefusal(`The photo re-host tool refuses to run: ${failed.join("; ")}`, d.checks);
  return { cloudName, folder, environment: d.environment };
}

/** host + path of an https URL, without query/fragment/credentials; null when unusable. */
export function safeSource(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || !AIRTABLE_HOST.test(u.hostname)) return null;
    return { host: u.hostname.toLowerCase(), path: u.pathname.slice(0, 300) };
  } catch { return null; }
}

/** Builds the real uploader around the cloudinary SDK. Tests inject their own with the same shape. */
export async function cloudinaryUploader(cloudinaryUrl) {
  const { v2 } = await import("cloudinary");
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(cloudinaryUrl);
  v2.config({ cloud_name: m[3], api_key: m[1], api_secret: m[2], secure: true });
  return {
    cloudName: m[3],
    async upload(sourceUrl, { publicId }) {   // Cloudinary fetches the source itself; overwrite=false returns the existing asset on a retry
      try {
        const r = await v2.uploader.upload(sourceUrl, { public_id: publicId, overwrite: false, resource_type: "image", unique_filename: false, use_filename: false, invalidate: false });
        return { publicId: r.public_id, url: r.secure_url, width: r.width, height: r.height, bytes: r.bytes, existing: Boolean(r.existing) };
      } catch (e) {
        const status = e?.http_code ?? e?.error?.http_code;
        const msg = String(e?.message ?? e?.error?.message ?? "upload failed");
        throw Object.assign(new Error(msg), { httpCode: status });
      }
    },
  };
}

function classify(e) {
  const code = e?.httpCode;
  if (code === 400 || code === 401 || code === 403 || code === 404 || code === 410) return "source_inaccessible";   // expired/forbidden/missing source (Cloudinary reports the fetch failure as 400)
  if (code === 420 || code === 429 || code >= 500 || code === undefined) return "provider_error";
  return "rejected";
}
const scrub = (s) => String(s).replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").slice(0, 300);

export async function pendingPhotos(pool, { maxAttempts, limit }) {
  const { rows } = await pool.query(
    `SELECT p.id, p.item_id, p.url, p.sort_order, p.legacy_attachment_id,
            (SELECT count(*)::int FROM photo_rehost_log l WHERE l.photo_id = p.id AND l.outcome = 'failed') AS failures
       FROM item_photos p
      WHERE p.storage_provider = 'airtable' AND p.archived_at IS NULL
        AND (SELECT count(*) FROM photo_rehost_log l WHERE l.photo_id = p.id AND l.outcome = 'failed') < $1
      ORDER BY p.created_at, p.id LIMIT $2`, [maxAttempts, limit]);
  return rows;
}

/**
 * @param {{ pool: import("pg").Pool, uploader: { cloudName: string, upload: Function }, folder: string, limit?: number, maxAttempts?: number, dryRun?: boolean, runId?: string }} o
 */
export async function rehostPhotos({ pool, uploader, folder, limit = 100, maxAttempts = 3, dryRun = false, runId = randomUUID() }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ImportRefusal("--limit must be 1..5000");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new ImportRefusal("--max-attempts must be 1..10");
  const lock = await pool.connect();
  try {
    if (!(await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0].ok) throw new ImportRefusal("another re-host run is in progress");
    const todo = await pendingPhotos(pool, { maxAttempts, limit });
    const out = { runId, dryRun, selected: todo.length, uploaded: 0, failed: 0, skippedUnsafeSource: 0, details: [] };
    for (const p of todo) {
      const src = safeSource(p.url);
      if (!src) { out.skippedUnsafeSource++; out.details.push({ photoId: p.id, itemId: p.item_id, result: "skipped_unsafe_source" }); continue; }
      if (dryRun) { out.details.push({ photoId: p.id, itemId: p.item_id, result: "would_upload", sourceHost: src.host, priorFailures: p.failures }); continue; }
      const publicId = `${folder}/${p.id}`;
      let res; let failure = null;
      try {
        res = await uploader.upload(p.url, { publicId });
        if (res?.publicId !== publicId || typeof res.url !== "string" || !res.url.startsWith(`https://res.cloudinary.com/${uploader.cloudName}/`)) failure = { cls: "invalid_response", detail: "provider answer did not match the requested asset" };
      } catch (e) { failure = { cls: classify(e), detail: scrub(e?.message ?? "upload failed") }; }
      if (failure) {
        await pool.query(`INSERT INTO photo_rehost_log (run_id, photo_id, item_id, outcome, error_class, error_detail, source_host, source_path) VALUES ($1,$2,$3,'failed',$4,$5,$6,$7)`,
          [runId, p.id, p.item_id, failure.cls, failure.detail, src.host, src.path]);
        out.failed++; out.details.push({ photoId: p.id, itemId: p.item_id, result: "failed", errorClass: failure.cls, attempt: p.failures + 1 });
        continue;
      }
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const u = await tx.query(
          `UPDATE item_photos SET storage_provider = 'cloudinary', public_id = $2, url = $3, width = COALESCE($4, width), height = COALESCE($5, height),
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('rehosted_from_host', $6::text, 'rehosted_from_path', $7::text, 'rehost_run', $8::text)
            WHERE id = $1 AND storage_provider = 'airtable' AND url = $9 AND archived_at IS NULL`,
          [p.id, res.publicId, res.url, res.width ?? null, res.height ?? null, src.host, src.path, runId, p.url]);
        if (u.rowCount !== 1) {   // changed under us (archived, edited): keep the new state, record why
          await tx.query(`INSERT INTO photo_rehost_log (run_id, photo_id, item_id, outcome, error_class, error_detail, source_host, source_path) VALUES ($1,$2,$3,'failed','concurrent_change','row changed during re-host',$4,$5)`, [runId, p.id, p.item_id, src.host, src.path]);
          out.failed++; out.details.push({ photoId: p.id, itemId: p.item_id, result: "failed", errorClass: "concurrent_change" });
        } else {
          await tx.query(`INSERT INTO photo_rehost_log (run_id, photo_id, item_id, outcome, source_host, source_path, public_id, new_url) VALUES ($1,$2,$3,'uploaded',$4,$5,$6,$7)`, [runId, p.id, p.item_id, src.host, src.path, res.publicId, res.url]);
          out.uploaded++; out.details.push({ photoId: p.id, itemId: p.item_id, result: res.existing ? "uploaded_existing_asset" : "uploaded", publicId: res.publicId });
        }
        await tx.query("COMMIT");
      } catch (e) { await tx.query("ROLLBACK").catch(() => {}); throw e; } finally { tx.release(); }
    }
    return out;
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    lock.release();
  }
}

/** Read-only status: what is done, what remains, what needs a human. */
export async function rehostReport(pool, { maxAttempts = 3 } = {}) {
  const byProvider = (await pool.query(`SELECT storage_provider, count(*)::int AS n FROM item_photos WHERE archived_at IS NULL GROUP BY 1 ORDER BY 1`)).rows;
  const pending = (await pool.query(
    `SELECT p.id AS photo_id, p.item_id, (SELECT count(*)::int FROM photo_rehost_log l WHERE l.photo_id = p.id AND l.outcome='failed') AS failures,
            (SELECT l.error_class FROM photo_rehost_log l WHERE l.photo_id = p.id AND l.outcome='failed' ORDER BY l.id DESC LIMIT 1) AS last_error
       FROM item_photos p WHERE p.storage_provider = 'airtable' AND p.archived_at IS NULL ORDER BY p.created_at, p.id`)).rows;
  return {
    byProvider: Object.fromEntries(byProvider.map((r) => [r.storage_provider, r.n])),
    remainingAirtable: pending.length,
    needsReview: pending.filter((r) => r.failures >= maxAttempts).map((r) => ({ photoId: r.photo_id, itemId: r.item_id, failures: r.failures, lastError: r.last_error })),
    retryable: pending.filter((r) => r.failures < maxAttempts).length,
    otherProviderNotAutomated: (byProvider.find((r) => r.storage_provider === "other")?.n ?? 0),
    retirementReady: pending.length === 0 && !byProvider.some((r) => r.storage_provider === "other"),
  };
}
