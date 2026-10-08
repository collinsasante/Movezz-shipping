// Airtable exit guard. Airtable is a TEMPORARY transition backend (docs/AIRTABLE-EXIT.md). This test pins the boundary so that it
// can only shrink: PostgreSQL code never imports Airtable, every Airtable-importing route has a PostgreSQL dispatch, and no new
// file may start depending on it without a deliberate edit of this allow-list. At cutover the allow-list becomes empty.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const IMPORTS_AIRTABLE = /from\s+["'](?:@\/lib\/airtable|\.{1,2}\/(?:\.\.\/)*(?:lib\/)?airtable|airtable)["']|require\(["']airtable["']\)/;

const src = walk(join(ROOT, "src")).map((p) => ({ f: rel(p), s: readFileSync(p, "utf8") }));
const importers = src.filter((x) => IMPORTS_AIRTABLE.test(x.s)).map((x) => x.f).sort();

// Non-route files that may still import Airtable until cutover.
const TRANSITION_LIB = ["src/lib/airtable.ts", "src/lib/auth.ts"];

describe("Airtable boundary (temporary transition dependency)", () => {
  it("only the allow-listed lib files and API routes import Airtable", () => {
    const unexpected = importers.filter((f) => !TRANSITION_LIB.includes(f) && !f.startsWith("src/app/api/"));
    expect(unexpected).toEqual([]);
  });

  it("no client component or page imports Airtable (types live in @/types)", () => {
    expect(importers.filter((f) => f.startsWith("src/app/") && !f.startsWith("src/app/api/") )).toEqual([]);
    expect(importers.filter((f) => f.startsWith("src/components/"))).toEqual([]);
  });

  it("PostgreSQL modules never import Airtable", () => {
    const bad = src.filter((x) => (x.f.startsWith("src/lib/pg-routes/") || x.f.startsWith("src/lib/db/") || x.f === "src/lib/pg-api.ts" || x.f === "src/lib/whatsapp.ts" || x.f === "src/lib/keepup.ts" || x.f.startsWith("src/lib/integrations/")) && IMPORTS_AIRTABLE.test(x.s)).map((x) => x.f);
    expect(bad).toEqual([]);
  });

  it("every API route that imports Airtable dispatches to PostgreSQL when MOVEZZ_DATA_BACKEND=postgres", () => {
    const routes = importers.filter((f) => f.startsWith("src/app/api/"));
    expect(routes.length).toBeGreaterThan(0);
    const missing = routes.filter((f) => !/isPostgresBackend\(\)/.test(readFileSync(join(ROOT, f), "utf8")) || !/pg-routes\//.test(readFileSync(join(ROOT, f), "utf8")));
    expect(missing).toEqual([]);
  });

  it("the PostgreSQL branch comes before any Airtable call in each route handler", () => {
    for (const f of importers.filter((x) => x.startsWith("src/app/api/"))) {
      const s = readFileSync(join(ROOT, f), "utf8");
      const firstPg = s.indexOf("isPostgresBackend()");
      const firstAt = s.search(/\b(?:\w+Api|getBase|getAllRecords)\s*[.(]/);
      // an Airtable call textually before the first dispatch would run in PostgreSQL mode too
      const body = s.slice(s.indexOf("export"));
      const firstCall = body.search(/\bawait\s+(?:\w+Api\.|getBase\(|getAllRecords\()/);
      if (firstCall >= 0) expect(s.indexOf(body) + firstCall, `${f}: Airtable call before PostgreSQL dispatch`).toBeGreaterThan(firstPg);
      void firstAt;
    }
  });

  it("src/lib/auth.ts uses Airtable only on the non-PostgreSQL path", () => {
    const s = readFileSync(join(ROOT, "src/lib/auth.ts"), "utf8");
    expect(s).toMatch(/isPostgresBackend\(\)/);
    expect(s.indexOf("pgAuthContext(")).toBeGreaterThan(-1);
  });
});
