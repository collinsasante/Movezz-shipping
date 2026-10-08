// In-memory stand-in for the `airtable` npm package, used ONLY by the tests.
//
// It lets the REAL data layer (src/lib/airtable.ts) and the REAL route
// handlers run against deterministic in-memory tables, so the tests can
// characterize genuine application behavior without ever contacting Airtable.
//
// Fidelity notes (what is and is not modelled):
//  * Supported formula constructs: {Field}, 'string', numbers, =, AND, OR, NOT,
//    SEARCH, FIND, LOWER, ARRAYJOIN, RECORD_ID. Anything else THROWS, so a new
//    query shape in the application fails loudly instead of silently returning
//    wrong data.
//  * Like real Airtable, empty values ("" / null / [] / false) are omitted from
//    stored records, and `null` clears a field.
//  * NOT modelled (UNVERIFIED without access to the production base): lookup /
//    rollup / formula fields, automatic inverse linked-record syncing, select
//    option validation, unknown-field rejection, rate limits. Tests therefore
//    assert only what the application code itself reads and writes.
export type Fields = Record<string, unknown>;

export interface FakeRecord {
  id: string;
  fields: Fields;
  _rawJson: { id: string; createdTime: string; fields: Fields };
}

export interface WriteInfo {
  table: string;
  op: "create" | "update" | "destroy";
  id?: string;
  fields?: Fields;
}

// ---------------------------------------------------------------------------
// Formula evaluation (minimal subset)
// ---------------------------------------------------------------------------
type Tok =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "field"; v: string }
  | { t: "id"; v: string }
  | { t: "(" | ")" | "," | "=" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (c === "{") {
      const j = src.indexOf("}", i);
      toks.push({ t: "field", v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (/[0-9.]/.test(src[j] ?? "")) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (/[A-Za-z_0-9]/.test(src[j] ?? "")) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(" || c === ")" || c === "," || c === "=") {
      toks.push({ t: c });
      i++;
      continue;
    }
    throw new Error(`fakeAirtable: unsupported formula token '${c}' in: ${src}`);
  }
  return toks;
}

type Val = unknown;
const isEmpty = (v: Val) => v === undefined || v === null;
const truthy = (v: Val) => !(isEmpty(v) || v === 0 || v === "" || v === false);

function looseEquals(a: Val, b: Val): boolean {
  if (isEmpty(a) || isEmpty(b)) {
    const other = isEmpty(a) ? b : a;
    // A blank cell equals '' and 0 (blank checkbox / blank text), nothing else.
    return isEmpty(other) || other === "" || other === 0 || other === false;
  }
  if (typeof a === "boolean") a = Number(a);
  if (typeof b === "boolean") b = Number(b);
  return a === b;
}

function evalFormula(src: string, rec: FakeRecord): Val {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => {
    const k = next();
    if (!k || k.t !== t) throw new Error(`fakeAirtable: expected '${t}' in: ${src}`);
  };

  function parseCmp(): Val {
    const left = parsePrimary();
    if (peek()?.t === "=") {
      next();
      const right = parsePrimary();
      return looseEquals(left, right) ? 1 : 0;
    }
    return left;
  }

  function parseArgs(): Val[] {
    const args: Val[] = [];
    expect("(");
    if (peek()?.t === ")") { next(); return args; }
    for (;;) {
      args.push(parseCmp());
      const k = next();
      if (!k) throw new Error(`fakeAirtable: unterminated call in: ${src}`);
      if (k.t === ")") break;
      if (k.t !== ",") throw new Error(`fakeAirtable: expected ',' in: ${src}`);
    }
    return args;
  }

  function parsePrimary(): Val {
    const k = next();
    if (!k) throw new Error(`fakeAirtable: unexpected end of formula: ${src}`);
    if (k.t === "str" || k.t === "num") return k.v;
    if (k.t === "field") return rec.fields[k.v];
    if (k.t === "(") { const v = parseCmp(); expect(")"); return v; }
    if (k.t === "id") {
      const name = k.v.toUpperCase();
      const args = parseArgs();
      switch (name) {
        case "AND": return args.every(truthy) ? 1 : 0;
        case "OR": return args.some(truthy) ? 1 : 0;
        case "NOT": return truthy(args[0]) ? 0 : 1;
        case "LOWER": return String(args[0] ?? "").toLowerCase();
        case "RECORD_ID": return rec.id;
        case "ARRAYJOIN": {
          const a = args[0];
          return Array.isArray(a) ? a.join(String(args[1] ?? ",")) : String(a ?? "");
        }
        case "SEARCH":
        case "FIND": {
          const idx = String(args[1] ?? "").indexOf(String(args[0] ?? ""));
          return idx >= 0 ? idx + 1 : 0;
        }
        default:
          throw new Error(`fakeAirtable: unsupported formula function ${k.v}() in: ${src}`);
      }
    }
    throw new Error(`fakeAirtable: unexpected token in: ${src}`);
  }

  const result = parseCmp();
  if (p < toks.length) throw new Error(`fakeAirtable: trailing tokens in: ${src}`);
  return result;
}

// ---------------------------------------------------------------------------
// The in-memory database
// ---------------------------------------------------------------------------
function normalizeFields(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === "Photos" && Array.isArray(v)) {
      out[k] = v.map((p, i) => {
        const o = p as { url?: string };
        return { id: `att${i}`, url: o.url, filename: "photo.jpg", size: 0, type: "image/jpeg" };
      });
      continue;
    }
    out[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

export class FakeDb {
  private tables = new Map<string, Map<string, FakeRecord>>();
  private seq = 0;
  /** Every call the application made, e.g. {table:"Items", op:"find"} */
  calls: { table: string; op: string; id?: string }[] = [];
  /** Optional failure-injection hook: throw from here to simulate an API error. */
  beforeWrite?: (info: WriteInfo) => void;

  reset() {
    this.tables = new Map();
    this.seq = 0;
    this.calls = [];
    this.beforeWrite = undefined;
  }

  private t(name: string) {
    let m = this.tables.get(name);
    if (!m) { m = new Map(); this.tables.set(name, m); }
    return m;
  }

  private nextId() {
    this.seq++;
    return `recFAKE${String(this.seq).padStart(6, "0")}`;
  }

  private createdTime() {
    // Strictly increasing, deterministic.
    return new Date(Date.UTC(2026, 0, 1, 0, this.seq, 0)).toISOString();
  }

  private make(id: string, fields: Fields): FakeRecord {
    const f = normalizeFields(fields);
    return { id, fields: f, _rawJson: { id, createdTime: this.createdTime(), fields: f } };
  }

  /** Test seeding: insert a record directly (bypasses call log and hooks). */
  insert(table: string, fields: Fields, id?: string): FakeRecord {
    const rid = id ?? this.nextId();
    const rec = this.make(rid, fields);
    this.t(table).set(rid, rec);
    return rec;
  }

  /** Test inspection helpers (not counted as application calls). */
  all(table: string): FakeRecord[] {
    return [...this.t(table).values()];
  }
  get(table: string, id: string): FakeRecord | undefined {
    return this.t(table).get(id);
  }
  count(table: string, op?: string): number {
    return this.calls.filter((c) => c.table === table && (!op || c.op === op)).length;
  }
  clearCalls() {
    this.calls = [];
  }

  // ---- application-facing operations (what the airtable SDK would do) ----
  select(table: string, opts: { filterByFormula?: string; sort?: { field: string; direction?: string }[] } = {}) {
    this.calls.push({ table, op: "select" });
    let recs = this.all(table);
    if (opts.filterByFormula) recs = recs.filter((r) => truthy(evalFormula(opts.filterByFormula!, r)));
    if (opts.sort?.length) {
      const sorts = opts.sort;
      recs = [...recs].sort((a, b) => {
        for (const s of sorts) {
          const av = a.fields[s.field] as string | number | undefined;
          const bv = b.fields[s.field] as string | number | undefined;
          if (av === bv) continue;
          if (av === undefined) return 1;
          if (bv === undefined) return -1;
          const cmp = av < bv ? -1 : 1;
          return s.direction === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    return recs;
  }

  find(table: string, id: string): FakeRecord {
    this.calls.push({ table, op: "find", id });
    const r = this.t(table).get(id);
    if (!r) throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404, error: "NOT_FOUND" });
    return r;
  }

  create(table: string, fields: Fields): FakeRecord {
    const info: WriteInfo = { table, op: "create", fields };
    this.beforeWrite?.(info);
    this.calls.push({ table, op: "create" });
    const rec = this.make(this.nextId(), fields);
    this.t(table).set(rec.id, rec);
    return rec;
  }

  update(table: string, id: string, fields: Fields): FakeRecord {
    this.beforeWrite?.({ table, op: "update", id, fields });
    this.calls.push({ table, op: "update", id });
    const existing = this.t(table).get(id);
    if (!existing) throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404, error: "NOT_FOUND" });
    const merged: Fields = { ...existing.fields };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0)) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
    const next = this.make(id, merged);
    next._rawJson.createdTime = existing._rawJson.createdTime;
    this.t(table).set(id, next);
    return next;
  }

  destroy(table: string, id: string): void {
    this.beforeWrite?.({ table, op: "destroy", id });
    this.calls.push({ table, op: "destroy", id });
    if (!this.t(table).delete(id)) {
      throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404, error: "NOT_FOUND" });
    }
  }
}

// One database per test process, shared by every (re-)evaluated copy of this
// module. vi.resetModules() re-evaluates modules, so the instance lives on globalThis.
const KEY = "__MOVEZZ_FAKE_AIRTABLE_DB__";
export function getDb(): FakeDb {
  const g = globalThis as unknown as Record<string, FakeDb | undefined>;
  if (!g[KEY]) g[KEY] = new FakeDb();
  return g[KEY]!;
}

// ---------------------------------------------------------------------------
// Shape of the `airtable` package default export, as used by the application
// ---------------------------------------------------------------------------
type SelectOpts = { filterByFormula?: string; sort?: { field: string; direction?: string }[]; pageSize?: number };

function tableApi(name: string) {
  const db = getDb();
  const api = (() => undefined) as unknown as {
    select: (o?: SelectOpts) => { eachPage: (cb: (recs: FakeRecord[], next: () => void) => void) => Promise<void> };
    find: (id: string) => Promise<FakeRecord>;
    create: (fields: Fields) => Promise<FakeRecord>;
    update: (a: string | { id: string; fields: Fields }[], b?: Fields) => Promise<FakeRecord | FakeRecord[]>;
    destroy: (id: string) => Promise<FakeRecord>;
  };
  api.select = (o = {}) => ({
    eachPage: async (cb) => {
      const recs = db.select(name, o);
      cb(recs, () => undefined);
    },
  });
  api.find = async (id) => db.find(name, id);
  api.create = async (fields) => db.create(name, fields);
  api.update = async (a, b) => {
    if (Array.isArray(a)) return a.map((u) => db.update(name, u.id, u.fields));
    return db.update(name, a, b ?? {});
  };
  api.destroy = async (id) => {
    const rec = db.get(name, id) as FakeRecord;
    db.destroy(name, id);
    return rec;
  };
  return api;
}

export default class Airtable {
  constructor(_opts?: unknown) {}
  static configure(_opts?: unknown) {}
  base(_baseId: string) {
    return (name: string) => tableApi(name);
  }
}
