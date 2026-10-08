// Dangerous legacy endpoints removed in Phase 5. These tests make sure they cannot silently come back.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { standardWorld, listRouteMethods } from "../helpers/world";

const REMOVED = ["debug-history", "admin/migrate-shipping-marks"];

describe("removed legacy endpoints", () => {
  it("have no route handler on disk", () => {
    for (const r of REMOVED) expect(fs.existsSync(path.resolve("src/app/api", r, "route.ts")), r).toBe(false);
  });

  it("are not registered as routes", async () => {
    await standardWorld();
    const routes = (await listRouteMethods()).map((e) => e.route);
    for (const r of REMOVED) expect(routes).not.toContain(r);
  });

  it("do not exist even for a super_admin (the call fails: no such route)", async () => {
    const { w, admin } = await standardWorld();
    await expect(w.call("debug-history", "GET", { token: admin })).rejects.toThrow(/No such route/);
    await expect(w.call("admin/migrate-shipping-marks", "POST", { token: admin })).rejects.toThrow(/No such route/);
  });

  it("no source file still writes debug records into production tables", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /delete me|debug test|TEST-debug/i.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
