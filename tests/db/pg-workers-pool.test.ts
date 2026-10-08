import { describe, it, expect } from "vitest";
import { createPool, isWorkersRuntime } from "../../src/lib/db/client";

describe("PostgreSQL pool on Cloudflare Workers", () => {
  it("detects the Workers runtime only by its user agent", () => {
    expect(isWorkersRuntime("Cloudflare-Workers")).toBe(true);
    expect(isWorkersRuntime("Node.js/22")).toBe(false);
    expect(isWorkersRuntime(undefined)).toBe(false);
  });
  it("never reuses a connection across requests on Workers; keeps normal pooling elsewhere", async () => {
    const w = createPool("postgres://u@127.0.0.1:1/db", { workers: true }); const n = createPool("postgres://u@127.0.0.1:1/db", { workers: false });
    expect(w.options).toMatchObject({ maxUses: 1, idleTimeoutMillis: 1 });
    expect(n.options.maxUses).not.toBe(1);
    await w.end(); await n.end();
  });
});
