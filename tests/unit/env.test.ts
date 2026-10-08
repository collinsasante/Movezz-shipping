import { describe, it, expect, afterEach } from "vitest";
import { readEnv, hyperdriveUrl } from "@/lib/env";
import { dataBackend } from "@/lib/backend";

const KEY = Symbol.for("__cloudflare-context__");
const g = globalThis as Record<symbol, unknown>;
afterEach(() => { delete g[KEY]; delete process.env.MOVEZZ_DATA_BACKEND; delete process.env.XYZ_TEST; });

describe("environment lookup inside a Worker", () => {
  it("process.env wins; otherwise the Cloudflare context env is used; empty is absent", () => {
    g[KEY] = { env: { XYZ_TEST: "from-worker", EMPTY: "" } };
    expect(readEnv("XYZ_TEST")).toBe("from-worker"); expect(readEnv("EMPTY")).toBeUndefined(); expect(readEnv("NOPE")).toBeUndefined();
    process.env.XYZ_TEST = "from-process"; expect(readEnv("XYZ_TEST")).toBe("from-process");
  });
  it("the data backend is selectable from Worker vars, defaults to airtable and still fails closed on a bad value", () => {
    expect(dataBackend()).toBe("airtable");
    g[KEY] = { env: { MOVEZZ_DATA_BACKEND: "postgres" } }; expect(dataBackend()).toBe("postgres");
    g[KEY] = { env: { MOVEZZ_DATA_BACKEND: "mongo" } }; expect(() => dataBackend()).toThrow(/must be/);
  });
  it("a Hyperdrive binding is read only when present", () => {
    expect(hyperdriveUrl()).toBeUndefined();
    g[KEY] = { env: { HYPERDRIVE: { connectionString: "postgres://u:p@hyperdrive.local:5432/db" } } }; expect(hyperdriveUrl()).toMatch(/^postgres:/);
    g[KEY] = { env: { HYPERDRIVE: {} } }; expect(hyperdriveUrl()).toBeUndefined();
  });
});
