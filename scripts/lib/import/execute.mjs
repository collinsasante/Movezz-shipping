// Stage 6 - IMPORT (and the read-only target pre-check shared with the dry-run).
//
// Guarantees:
//   * every source record maps to at most one target row (import_records, unique on source and on target)
//   * a record and its mapping are written in the SAME transaction, so a crash leaves either both or neither -> the run is resumable
//     and a second run of the same snapshot imports nothing new
//   * each record is isolated in a savepoint: a database rejection quarantines that record (DB_REJECTED) and never aborts the batch
//   * the importer acts as the signed IMPORT actor only; it creates no users, assigns no roles, links no Firebase identity, creates no
//     Keepup sync rows and no notifications
//   * historical financial snapshots are inserted exactly as verified - nothing is priced, converted or recalculated
import { actorKeyFromEnv, beginImportActor } from "./actor.mjs";
import { ImportError } from "./errors.mjs";
import { IMPORTER_VERSION, fingerprint } from "./util.mjs";
import { paymentEvents } from "./financial.mjs";
import { snapshotFingerprint } from "./snapshot.mjs";
import { collectEntries, validateAll } from "./validate.mjs";

export const LOCK_KEY = 7282016;
const K = (t, id) => `${t}\u0000${id}`;

// ---------------------------------------------------------------------------------------------------------------------------
/** READ-ONLY look at the target: existing mappings and unique business references that would collide. Never writes. */
export async function readTargetState(client, st) {
  const mappings = new Map();
  const m = await client.query("SELECT source_table, source_id, target_table, target_id, content_fingerprint FROM import_records");
  for (const r of m.rows) mappings.set(K(r.source_table, r.source_id), { targetTable: r.target_table, targetId: r.target_id, fp: r.content_fingerprint });
  const taken = async (sql, values) => new Set((await client.query(sql, [values])).rows.map((r) => r.v));
  const vals = (t, f) => [...new Set(st.validList(t).map(f).filter(Boolean))];
  const conflicts = {
    customer_mark: await taken("SELECT shipping_mark AS v FROM customers WHERE shipping_mark = ANY($1)", vals("Customers", (r) => r.row.shipping_mark)),
    container_ref: await taken("SELECT container_ref AS v FROM containers WHERE container_ref = ANY($1)", vals("Containers", (r) => r.row.container_ref)),
    supplier_ref: await taken("SELECT supplier_ref AS v FROM suppliers WHERE supplier_ref = ANY($1)", vals("Suppliers", (r) => r.row.supplier_ref)),
    item_ref: await taken("SELECT item_ref AS v FROM items WHERE item_ref = ANY($1)", vals("Items", (r) => r.row.item_ref)),
    carton_ref: await taken("SELECT carton_ref AS v FROM cartons WHERE carton_ref = ANY($1)", st.cartons.map((c) => c.row.carton_ref)),
    invoice_ref: await taken("SELECT invoice_ref AS v FROM invoices WHERE invoice_ref = ANY($1)", vals("Orders", (r) => r.row.invoice_ref)),
    keepup_sale: await taken("SELECT keepup_sale_id AS v FROM invoices WHERE keepup_sale_id = ANY($1)", vals("Orders", (r) => r.row.keepup_sale_id)),
  };
  return { mappings, conflicts };
}

/** Blocks valid records that are NOT yet imported but whose business reference already exists in the target, then re-runs the cascade. */
export function applyTargetState(st, target) {
  const mapped = (t, id) => target.mappings.has(K(t, id));
  const hit = (set, v) => v && set.has(v);
  for (const r of st.validList("Customers")) if (!mapped("Customers", r.sourceId) && hit(target.conflicts.customer_mark, r.row.shipping_mark)) st.block("Customers", r.sourceId, "CONFLICTING_IDENTITY", "the shipping mark already belongs to a different customer in the target", "ShippingMark");
  for (const r of st.validList("Containers")) if (!mapped("Containers", r.sourceId) && hit(target.conflicts.container_ref, r.row.container_ref)) st.block("Containers", r.sourceId, "CONFLICTING_IDENTITY", "the container reference already exists in the target", "ContainerID");
  for (const r of st.validList("Suppliers")) if (!mapped("Suppliers", r.sourceId) && hit(target.conflicts.supplier_ref, r.row.supplier_ref)) st.block("Suppliers", r.sourceId, "CONFLICTING_IDENTITY", "the supplier reference already exists in the target", "SupplierID");
  for (const r of st.validList("Items")) if (!mapped("Items", r.sourceId) && hit(target.conflicts.item_ref, r.row.item_ref)) st.block("Items", r.sourceId, "CONFLICTING_IDENTITY", "the item reference already exists in the target", "ItemRef");
  for (const r of st.validList("Orders")) {
    if (mapped("Orders", r.sourceId)) continue;
    if (hit(target.conflicts.invoice_ref, r.row.invoice_ref)) st.block("Orders", r.sourceId, "CONFLICTING_IDENTITY", "the invoice reference already exists in the target", "OrderRef");
    else if (hit(target.conflicts.keepup_sale, r.row.keepup_sale_id)) st.block("Orders", r.sourceId, "CONFLICTING_IDENTITY", "the Keepup sale id is already attached to a different invoice in the target", "KeepupSaleId");
  }
  for (const c of st.cartons) if (!mapped("Cartons", c.sourceId) && hit(target.conflicts.carton_ref, c.row.carton_ref)) { st.block("Cartons", c.sourceId, "CONFLICTING_IDENTITY", "the carton reference already exists in the target", "CartonNumber"); for (const m of c.memberIds) st.block("Items", m, "INVALID_CARTON", `carton ${c.number} conflicts with the target`, "CartonNumber"); }
  return validateAll(st);
}

// ---------------------------------------------------------------------------------------------------------------------------
const dbReason = (e) => ({ category: String(e.code ?? "").startsWith("MV") ? "DB_REJECTED" : "DB_CONSTRAINT_VIOLATION", reason: `${e.code ?? "ERR"}${e.constraint ? ` ${e.constraint}` : ""}: ${String(e.message ?? "").replace(/\s+/g, " ").slice(0, 300)}` });
const J = (o) => JSON.stringify(o);

class Ctx {
  constructor(client, batchId, mappings, key, snapshot) {
    this.client = client; this.batchId = batchId; this.map = new Map([...mappings].map(([k, v]) => [k, v])); this.key = key; this.snapshot = snapshot;
    this.counts = {}; this.dbEntries = []; this.failed = new Set(); this.seq = 0; this.journal = [];
  }
  bump(table, what) { (this.counts[table] ??= { imported: 0, skipped: 0, failed: 0 })[what]++; }
  tid(table, id) { return this.map.get(K(table, id))?.targetId ?? null; }
}

async function withTx(ctx, tag, fn) {
  const { client } = ctx;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'"); await client.query("SET LOCAL statement_timeout = '60s'");
    await beginImportActor(client, ctx.key, `import:${ctx.batchId.slice(0, 8)}:${tag}:${++ctx.seq}`);
    ctx.journal = [];
    const r = await fn();
    await client.query("COMMIT");
    ctx.journal = [];
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // everything this transaction mapped is gone with it: forget it in memory too
    for (const j of ctx.journal) { ctx.map.delete(j.key); ctx.counts[j.table].imported--; }
    ctx.journal = [];
    throw e;
  }
}

async function insertMapped(ctx, srcTable, srcId, tgtTable, fp, run) {
  const { client } = ctx; const sp = `sp_${++ctx.seq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const targetId = await run();
    await client.query("INSERT INTO import_records (source_table, source_id, target_table, target_id, batch_id, content_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)", [srcTable, srcId, tgtTable, String(targetId), ctx.batchId, fp]);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    ctx.map.set(K(srcTable, srcId), { targetTable: tgtTable, targetId: String(targetId), fp });
    ctx.journal.push({ key: K(srcTable, srcId), table: srcTable });
    ctx.bump(srcTable, "imported");
    return targetId;
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    const d = dbReason(e);
    ctx.dbEntries.push({ table: srcTable, sourceId: srcId, category: d.category, severity: "blocking", reason: d.reason, field: null });
    ctx.failed.add(K(srcTable, srcId)); ctx.bump(srcTable, "failed");
    return null;
  }
}

/** Runs `units` in chunked transactions. unit = { table, id, fp, run(): Promise<targetId> | skip }. */
async function runStage(ctx, name, units, hooks, { perUnitTx = false, chunk = 100 } = {}) {
  await hooks.beforeStage?.(name);
  const todo = [];
  for (const u of units) {
    const have = ctx.map.get(K(u.table, u.id));
    if (have) { if (have.fp !== u.fp) ctx.dbEntries.push({ table: u.table, sourceId: u.id, category: "SOURCE_CHANGED", severity: "review", reason: "this record was imported earlier from different source content; it is NOT re-imported", field: null }); continue; }
    todo.push(u);
  }
  const size = perUnitTx ? 1 : chunk;
  for (let i = 0; i < todo.length; i += size) {
    const part = todo.slice(i, i + size);
    await withTx(ctx, name, async () => {
      for (const u of part) await u.run();
      await hooks.beforeCommit?.(name, Math.floor(i / size));
    });
  }
  await hooks.afterStage?.(name);
}

// ---------------------------------------------------------------------------------------------------------------------------
export async function runImport({ pool, snapshot, st, decision, initiatedBy, env = process.env, hooks = {}, chunk = 100 }) {
  if (!decision?.ok || decision.mode !== "import") throw new ImportError("IMPORT_REFUSED", "the environment guard has not approved an import");
  if (!initiatedBy || !/\S/.test(initiatedBy)) throw new ImportError("IMPORT_INITIATOR", "an initiator label is required");
  const key = actorKeyFromEnv(env);
  const client = await pool.connect();
  let batchId = null;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (!lock.rows[0].ok) throw new ImportError("IMPORT_RUNNING", "another import is running against this database");
    // we hold the lock, so no live importer exists: a 'running' batch is the remains of a crashed run
    await client.query("UPDATE import_batches SET status = 'failed', error = 'interrupted (the importer process ended before it finished)', finished_at = now() WHERE status = 'running'");
    const fp = snapshotFingerprint(snapshot);
    const tables = Object.keys(snapshot.tables).sort();
    batchId = (await client.query(
      `INSERT INTO import_batches (mode, snapshot_fingerprint, snapshot_label, snapshot_kind, snapshot_captured_at, importer_version, source_tables, initiated_by, environment_class)
       VALUES ('import', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [fp, snapshot.source.label || null, snapshot.source.kind, snapshot.source.capturedAt, IMPORTER_VERSION, tables, initiatedBy.slice(0, 200), decision.environment])).rows[0].id;

    // pre-check against the target, then re-validate (read only)
    await client.query("BEGIN READ ONLY");
    let target;
    try { target = await readTargetState(client, st); } finally { await client.query("ROLLBACK"); }
    applyTargetState(st, target);

    const ctx = new Ctx(client, batchId, target.mappings, key, snapshot);
    await stages(ctx, st, snapshot, hooks, chunk);
    await seedCounters(ctx);

    // persist the quarantine (blocking, review, deferred) of THIS run, in one transaction
    const entries = [...collectEntries(st), ...ctx.dbEntries];
    await client.query("BEGIN");
    try {
      for (let i = 0; i < entries.length; i += 200) {
        const part = entries.slice(i, i + 200);
        await client.query(
          `INSERT INTO import_quarantine (batch_id, source_table, source_id, category, severity, reason, field)
           SELECT $1, t, s, c, sv, r, f FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS x(t, s, c, sv, r, f)`,
          [batchId, part.map((e) => e.table), part.map((e) => e.sourceId.slice(0, 300)), part.map((e) => e.category), part.map((e) => e.severity), part.map((e) => e.reason.slice(0, 1000)), part.map((e) => e.field)]);
      }
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }

    // skipped = already mapped before this run: derived from the mapping so every table (lines, payments, photos too) is counted the same way
    const mappedBy = {}; for (const k of ctx.map.keys()) { const t = k.split("\u0000")[0]; mappedBy[t] = (mappedBy[t] ?? 0) + 1; }
    for (const [t, n] of Object.entries(mappedBy)) { const c = (ctx.counts[t] ??= { imported: 0, skipped: 0, failed: 0 }); c.skipped = n - c.imported; }
    const counts = { perTable: ctx.counts, quarantined: entries.filter((e) => e.severity === "blocking").length, review: entries.filter((e) => e.severity === "review").length, deferred: entries.filter((e) => e.severity === "deferred").length };
    await client.query("UPDATE import_batches SET status = 'completed', counts = $2, finished_at = now() WHERE id = $1", [batchId, J(counts)]);
    return { batchId, counts, entries, ctx };
  } catch (e) {
    if (batchId) await client.query("ROLLBACK").catch(() => {}).then(() => client.query("UPDATE import_batches SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'", [batchId, String(e.message).slice(0, 1900)])).catch(() => {});
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function stages(ctx, st, snapshot, hooks, chunk) {
  const c = ctx.client;
  const unit = (table, rec, run) => ({ table, id: rec.sourceId, fp: rec.fp, run: () => insertMapped(ctx, table, rec.sourceId, run.target, rec.fp, () => run.fn(rec)) });
  const one = async (sql, params) => (await c.query(sql, params)).rows[0].id;
  const live = (t) => st.validList(t).filter((r) => !ctx.failed.has(K(t, r.sourceId)));
  const needs = (table, rec, parents) => {                       // a parent that failed in the database makes its child unimportable
    for (const [pt, pid] of parents) if (pid && !ctx.tid(pt, pid)) { ctx.dbEntries.push({ table, sourceId: rec.sourceId, category: "PARENT_QUARANTINED", severity: "blocking", reason: `${pt} ${pid} was not imported`, field: null }); ctx.failed.add(K(table, rec.sourceId)); ctx.bump(table, "failed"); return false; }
    return true;
  };
  const guarded = (table, rec, parents, fn) => ({ table, id: rec.sourceId, fp: rec.fp, run: async () => { if (needs(table, rec, parents)) await fn(); } });
  const leg = (rec, extra = {}) => J({ ...rec.row.legacy_data, ...extra });

  await runStage(ctx, "warehouses", live("Warehouses").map((r) => unit("Warehouses", r, { target: "warehouses", fn: async () => one(
    "INSERT INTO warehouses (name, address, country, phone, is_active, legacy_airtable_id, legacy_data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id",
    [r.row.name, r.row.address, r.row.country, r.row.phone, r.row.is_active, r.sourceId, leg(r)]) })), hooks, { chunk });

  await runStage(ctx, "suppliers", live("Suppliers").map((r) => unit("Suppliers", r, { target: "suppliers", fn: async () => one(
    "INSERT INTO suppliers (supplier_ref, name, category, platform, platform_link, contact, contact_method, rating, notes, created_by, legacy_airtable_id, legacy_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id",
    [r.row.supplier_ref, r.row.name, r.row.category, r.row.platform, r.row.platform_link, r.row.contact, r.row.contact_method, r.row.rating, r.row.notes, r.row.created_by, r.sourceId, leg(r)]) })), hooks, { chunk });

  // package rates: one Airtable row (Sea + Air columns) -> two target rows, each mapped on its own
  const rateUnits = [];
  for (const r of live("PackageRates")) for (const fr of ["sea", "air"]) {
    const sid = `${r.sourceId}#${fr}`;
    rateUnits.push({ table: "PackageRates", id: sid, fp: fingerprint({ fp: r.fp, fr }), run: () => insertMapped(ctx, "PackageRates", sid, "package_rates", fingerprint({ fp: r.fp, fr }), () => one(
      "INSERT INTO package_rates (tier, freight_type, rate_usd, legacy_airtable_id, legacy_data) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id", [r.row.tier, fr, fr === "sea" ? r.row.sea_rate : r.row.air_rate, r.sourceId, leg(r)])) });
  }
  await runStage(ctx, "package_rates", rateUnits, hooks, { chunk });

  await runStage(ctx, "fx_rates", live("Settings").map((r) => unit("Settings", r, { target: "fx_rates", fn: async () => one(
    "INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at, created_by) VALUES ('USD','GHS',$1,'airtable-settings',$2,'legacy-import') RETURNING id", [r.row.rate, ctx.snapshot.source.capturedAt]) })), hooks, { chunk });

  await runStage(ctx, "special_rates", live("SpecialRates").map((r) => unit("SpecialRates", r, { target: "special_rates", fn: async () => one(
    "INSERT INTO special_rates (name, sea_rate_usd, air_rate_usd, provenance, provenance_note, legacy_airtable_id, legacy_data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id",
    [r.row.name, r.row.sea_rate_usd, r.row.air_rate_usd, r.row.provenance, r.row.provenance_note, r.sourceId, leg(r)]) })), hooks, { chunk });

  await runStage(ctx, "customers", live("Customers").map((r) => guarded("Customers", r, [["Warehouses", r.rels.warehouse]], () => insertMapped(ctx, "Customers", r.sourceId, "customers", r.fp, () => one(
    `INSERT INTO customers (name, phone, email, shipping_mark, shipping_address, shipping_type, package_tier, preferred_warehouse_id, notes, status, created_by, legacy_airtable_id, legacy_data, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, coalesce($14::timestamptz, now())) RETURNING id`,
    [r.row.name, r.row.phone, r.row.email, r.row.shipping_mark, r.row.shipping_address, r.row.shipping_type, r.row.package_tier, ctx.tid("Warehouses", r.rels.warehouse), r.row.notes, r.row.status, r.row.created_by, r.sourceId, leg(r), r.row.created_at])))), hooks, { chunk });

  await runStage(ctx, "containers", live("Containers").map((r) => unit("Containers", r, { target: "containers", fn: async () => one(
    "INSERT INTO containers (container_ref, container_number, shipping_line, description, status, eta, arrival_date, notes, created_by, legacy_airtable_id, legacy_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id",
    [r.row.container_ref, r.row.container_number, r.row.shipping_line, r.row.description, r.row.status, r.row.eta, r.row.arrival_date, r.row.notes, r.row.created_by, r.sourceId, leg(r)]) })), hooks, { chunk });

  // invoices: HEADERS only (always inserted open; lines, payments and the historical cancellation follow, in the only order the guards allow)
  const verified = new Map(st.validList("VerifiedInvoices").map((v) => [v.rels.order, v]));
  await runStage(ctx, "invoices", live("Orders").map((o) => { const v = verified.get(o.sourceId);
    return guarded("Orders", o, [["Customers", o.rels.customer]], () => insertMapped(ctx, "Orders", o.sourceId, "invoices", o.fp, () => one(
      `INSERT INTO invoices (invoice_ref, customer_id, invoice_date, subtotal_usd, discount_usd, discount_reason, fx_rate, fx_estimated, total_ghs, keepup_sale_id, keepup_link, notes,
                             provenance, provenance_note, legacy_airtable_id, legacy_data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb, coalesce($17::timestamptz, now())) RETURNING id`,
      [o.row.invoice_ref, ctx.tid("Customers", o.rels.customer), o.row.invoice_date, v.row.subtotal_usd, v.row.discount_usd, v.row.discount_reason, v.row.fx_rate, v.row.fx_estimated, v.row.total_ghs,
       o.row.keepup_sale_id, o.row.keepup_link, o.row.notes, v.row.fx_estimated ? "estimated" : "legacy_known",
       v.row.fx_estimated ? `Frozen FX rate was estimated in the verified source: ${v.row.note}` : null, o.sourceId,
       leg(o, { source_status: o.sourceStatus, verified_note: v.row.note ?? null }), o.row.created_at]))); }), hooks, { perUnitTx: true });

  // cartons (after invoices: an invoiced carton references its invoice)
  await runStage(ctx, "cartons", st.cartons.filter((k) => !ctx.failed.has(K("Cartons", k.sourceId))).map((k) => guarded("Cartons", k, [["Customers", k.rels.customer], ["Containers", k.rels.container], ["Orders", k.rels.order]], () => insertMapped(ctx, "Cartons", k.sourceId, "cartons", k.fp, () => one(
    `INSERT INTO cartons (carton_ref, customer_id, container_id, freight_type, length, width, height, dimension_unit, weight_kg, package_tier, rate_usd, price_usd, pricing_basis, status, invoice_id, created_by, legacy_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) RETURNING id`,
    [k.row.carton_ref, ctx.tid("Customers", k.rels.customer), ctx.tid("Containers", k.rels.container), k.row.freight_type, k.row.length, k.row.width, k.row.height, k.row.dimension_unit, k.row.weight_kg,
     k.row.package_tier, k.row.rate_usd, k.row.price_usd, k.row.pricing_basis, k.row.status, ctx.tid("Orders", k.rels.order), k.row.created_by, J(k.row.legacy_data)])))), hooks, { chunk });

  // items (+ photos)
  const cartonOf = new Map(); for (const k of st.cartons) for (const m of k.memberIds) cartonOf.set(m, k);
  const photosOf = new Map(); for (const p of st.photos) (photosOf.get(p.itemId) ?? photosOf.set(p.itemId, []).get(p.itemId)).push(p);
  await runStage(ctx, "items", live("Items").map((i) => { const k = cartonOf.get(i.sourceId); const orderRec = i.rels.order ? st.rec("Orders", i.rels.order) : null; const released = orderRec?.sourceStatus === "Cancelled";
    return guarded("Items", i, [["Customers", i.rels.customer], ["Containers", i.rels.container], ["Orders", released ? null : i.rels.order], ["Cartons", k?.sourceId]], async () => {
      const id = await insertMapped(ctx, "Items", i.sourceId, "items", i.fp, () => one(
        `INSERT INTO items (item_ref, customer_id, container_id, carton_id, invoice_id, received_date, description, tracking_number, status, is_missing, freight_type, weight_kg, length, width, height, dimension_unit, quantity,
                            est_price_usd, tier_rate_usd, tier_price_usd, billing_basis, special_rate_name, special_rate_usd, special_price_usd, notes, created_by, provenance, legacy_airtable_id, legacy_data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'legacy_known',$27,$28::jsonb, coalesce($29::timestamptz, now())) RETURNING id`,
        [i.row.item_ref, ctx.tid("Customers", i.rels.customer), ctx.tid("Containers", i.rels.container), k ? ctx.tid("Cartons", k.sourceId) : null, released ? null : ctx.tid("Orders", i.rels.order), i.row.received_date,
         i.row.description, i.row.tracking_number, i.row.status, i.row.is_missing, i.row.freight_type, i.row.weight_kg, i.row.length, i.row.width, i.row.height, i.row.dimension_unit, i.row.quantity,
         i.row.est_price_usd, i.row.tier_rate_usd, i.row.tier_price_usd, i.row.billing_basis, i.row.special_rate_name, i.row.special_rate_usd, i.row.special_price_usd, i.row.notes, i.row.created_by, i.sourceId, leg(i), i.createdAt]));
      if (id) for (const p of photosOf.get(i.sourceId) ?? []) {
        await insertMapped(ctx, "ItemPhotos", p.sourceId, "item_photos", fingerprint(p), () => one(
          "INSERT INTO item_photos (item_id, storage_provider, public_id, url, width, height, sort_order, legacy_attachment_id, metadata) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id",
          [id, p.provider, p.url, p.width, p.height, p.idx, p.attachmentId, J({ source_table: "Items", source_id: i.sourceId })]));
      }
    }); }), hooks, { chunk });

  // invoice lines: one transaction per invoice (the lines-sum constraint is checked at COMMIT)
  const linesBy = new Map(); for (const l of st.validList("VerifiedInvoiceLines")) (linesBy.get(l.rels.order) ?? linesBy.set(l.rels.order, []).get(l.rels.order)).push(l);
  const lineUnits = [];
  for (const o of live("Orders")) {
    if (!ctx.tid("Orders", o.sourceId)) continue;
    const lines = (linesBy.get(o.sourceId) ?? []).sort((a, b) => a.row.line_no - b.row.line_no);
    if (!lines.length) continue;
    const prov = verified.get(o.sourceId).row.fx_estimated ? "estimated" : "legacy_known";
    lineUnits.push({ table: "VerifiedInvoiceLines", id: lines[0].sourceId, fp: lines[0].fp, skipIfMapped: true, run: async () => {
      if (lines.every((l) => ctx.map.has(K("VerifiedInvoiceLines", l.sourceId)))) return;
      for (const l of lines) {
        const itemId = l.rels.item ? ctx.tid("Items", l.rels.item) : null; const cartonId = l.rels.carton ? ctx.tid("Cartons", `carton:${l.rels.carton}`) : null;
        const r = await insertMapped(ctx, "VerifiedInvoiceLines", l.sourceId, "invoice_lines", l.fp, () => one(
          `INSERT INTO invoice_lines (invoice_id, line_no, item_id, carton_id, description, quantity, unit_price_usd, line_total_usd, billing_basis, package_tier, rate_usd, special_rate_name, metadata, provenance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING id`,
          [ctx.tid("Orders", o.sourceId), l.row.line_no, itemId, cartonId, l.row.description, l.row.quantity, l.row.unit_price_usd, l.row.line_total_usd, l.row.billing_basis, l.row.package_tier, l.row.rate_usd, l.row.special_rate_name,
           J({ source_table: "VerifiedInvoiceLines", source_id: l.sourceId, line_key: l.key }), prov]));
        if (r === null) throw new ImportError("LINE_FAILED", "an invoice line was rejected; the invoice's lines are rolled back together");
      }
    } });
  }
  // the first line's mapping is not enough to skip (all lines are checked inside run); remove the shortcut by clearing the generic skip
  await runLineStage(ctx, lineUnits, hooks);

  // payments, replayed in chronological order per invoice (a void frees balance for a later payment)
  const paysBy = new Map(); for (const p of st.validList("VerifiedPayments")) (paysBy.get(p.rels.order) ?? paysBy.set(p.rels.order, []).get(p.rels.order)).push(p);
  const payUnits = [];
  for (const o of live("Orders")) {
    const invId = ctx.tid("Orders", o.sourceId); const pays = (paysBy.get(o.sourceId) ?? []).sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
    if (!invId || !pays.length || pays.every((p) => ctx.map.has(K("VerifiedPayments", p.sourceId)))) continue;
    payUnits.push({ table: "VerifiedPayments", id: `inv:${o.sourceId}`, fp: "-", run: async () => {
      const ids = new Map();
      for (const e of paymentEvents(pays)) {
        const p = e.p;
        if (e.kind === "pay") {
          if (ctx.map.has(K("VerifiedPayments", p.sourceId))) { ids.set(p.sourceId, ctx.tid("VerifiedPayments", p.sourceId)); continue; }
          const id = await insertMapped(ctx, "VerifiedPayments", p.sourceId, "payments", p.fp, () => one(
            `INSERT INTO payments (invoice_id, amount_ghs, usd_equivalent, method, source, external_reference, keepup_reference, paid_at, legacy_airtable_id, legacy_data)
             VALUES ($1,$2,$3,$4,'import',$5,$6,$7,$8,$9::jsonb) RETURNING id`,
            [invId, p.row.amount_ghs, p.row.usd_equivalent, p.row.method, p.row.external_reference, p.row.keepup_reference, p.row.paid_at, p.sourceId, J({ source_table: "VerifiedPayments", source_id: p.sourceId, payment_key: p.key })]));
          if (id === null) throw new ImportError("PAYMENT_FAILED", "a payment was rejected; the invoice's payments are rolled back together");
          ids.set(p.sourceId, id);
        } else if (ids.get(p.sourceId) && (await c.query("SELECT status FROM payments WHERE id = $1", [ids.get(p.sourceId)])).rows[0].status === "completed") {
          await c.query("UPDATE payments SET status = 'voided', voided_at = $2, void_reason = $3 WHERE id = $1", [ids.get(p.sourceId), p.row.voided_at, p.row.void_reason]);
        }
      }
    } });
  }
  await runPaymentStage(ctx, payUnits, hooks);

  // historical cancellations (the import actor may cancel non-native invoices only; items/cartons were imported released)
  const cancels = live("Orders").filter((o) => o.sourceStatus === "Cancelled" && ctx.tid("Orders", o.sourceId));
  await hooks.beforeStage?.("cancellations");
  for (const o of cancels) {
    const info = st.cancelInfo.get(o.sourceId);
    await withTx(ctx, "cancel", async () => { await c.query("UPDATE invoices SET status = 'Cancelled', cancelled_at = $2, cancel_reason = $3 WHERE id = $1 AND status <> 'Cancelled'", [ctx.tid("Orders", o.sourceId), info.at, info.reason]); });
  }
  await hooks.afterStage?.("cancellations");

  // history (source timestamps and source identity preserved; actor_type 'import', never a user)
  const mapEntity = { item: "Items", container: "Containers", invoice: "Orders" };
  await runStage(ctx, "status_events", live("StatusHistory").map((e) => guarded("StatusHistory", e, [[mapEntity[e.row.entity_type], e.rels.entity]], () => insertMapped(ctx, "StatusHistory", e.sourceId, "status_events", e.fp, async () => one(
    `INSERT INTO status_events (entity_type, entity_id, old_status, new_status, actor_user_id, actor_type, reason, metadata, occurred_at, legacy_airtable_id, legacy_record_ref)
     VALUES ($1,$2,$3,$4,NULL,'import',$5,$6::jsonb,$7,$8,$9) RETURNING id`,
    [e.row.entity_type, ctx.tid(mapEntity[e.row.entity_type], e.rels.entity), e.row.old_status, e.row.new_status, e.row.reason,
     J({ legacy: true, source_table: "StatusHistory", source_id: e.sourceId, changed_by: e.row.changed_by, changed_by_role: e.row.changed_by_role, record_ref: e.row.record_ref }), e.row.occurred_at, e.sourceId, e.rels.entity])))), hooks, { chunk });

  const entityTable = { item: "Items", items: "Items", container: "Containers", containers: "Containers", order: "Orders", invoice: "Orders", orders: "Orders" };
  await runStage(ctx, "audit_logs", live("ActivityLogs").map((a) => unit("ActivityLogs", a, { target: "audit_logs", fn: async () => {
    const tt = entityTable[(a.row.entity_type ?? "").toLowerCase()]; const target = tt && a.rels.entity ? ctx.tid(tt, a.rels.entity) : null;
    return one(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data, request_id, ip_address, created_at)
       VALUES (NULL,'import',$1,$2,$3,NULL,$4::jsonb,$5,$6::inet,$7) RETURNING id`,
      [`legacy:${a.row.action}`.slice(0, 120), (a.row.entity_type ?? "legacy").slice(0, 60), target, J({ legacy: { source_table: "ActivityLogs", source_id: a.sourceId, user_email: a.row.user_email, user_role: a.row.user_role, details: a.row.details, entity_source_id: a.rels.entity ?? null } }),
       `import-${ctx.batchId}`.slice(0, 120), a.row.ip, a.row.created_at]); } })), hooks, { chunk });
}

async function runSetStage(ctx, name, category, units, hooks) {
  await hooks.beforeStage?.(name);
  for (const u of units) {
    try { await withTx(ctx, name, async () => { await u.run(); await hooks.beforeCommit?.(name, 0); }); }
    catch (e) {
      if (!(e instanceof ImportError)) throw e;
      ctx.dbEntries.push({ table: u.table, sourceId: u.id, category: "DB_REJECTED", severity: "blocking", reason: `${category} of this invoice were rejected as a set and rolled back`, field: null });
    }
  }
  await hooks.afterStage?.(name);
}
const runLineStage = (ctx, units, hooks) => runSetStage(ctx, "invoice_lines", "the invoice lines", units, hooks);
const runPaymentStage = (ctx, units, hooks) => runSetStage(ctx, "payments", "the payments", units, hooks);

/** Reference counters must be above every imported reference, or the next NATIVE record would collide. */
async function seedCounters(ctx) {
  const c = ctx.client;
  const spec = [["item", "items", "item_ref", /^ITM-(\d+)$/], ["invoice", "invoices", "invoice_ref", /^ORD-(\d+)$/], ["supplier", "suppliers", "supplier_ref", /^SUP-(\d+)$/], ["carton", "cartons", "carton_ref", /^CTN-(\d+)$/], ["container", "containers", "container_ref", /^PMX-CON-\d{4}-(\d+)$/]];
  await withTx(ctx, "counters", async () => {
    for (const [type, table, col, re] of spec) {
      const { rows } = await c.query(`SELECT ${col} AS ref FROM ${table}`);
      let max = 0n; for (const r of rows) { const m = re.exec(r.ref); if (m && BigInt(m[1]) > max) max = BigInt(m[1]); }
      if (max > 0n) await c.query("SELECT seed_reference_counter($1, '', $2)", [type, max.toString()]);
    }
  });
}
