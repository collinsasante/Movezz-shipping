// The Keepup gateway adapter against a LOCAL stub server (127.0.0.1, ephemeral port). No external network, no real credentials.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpKeepupGateway, assertSafeKeepupBaseUrl, type KeepupSaleRequest } from "../../src/lib/integrations/keepup-gateway";

const REQ: KeepupSaleRequest = { reference: "ORD-00042", idempotencyKey: "invoice:abc", customerName: "A", customerEmail: "a@example.invalid", customerPhone: "+233240000000", invoiceDate: "2026-01-02",
  items: [{ item_name: "Box", quantity: 1, price: 100 }] };

describe("Keepup HTTP gateway (local stub server)", () => {
  let server: http.Server; let base: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
  const seen: { url?: string; auth?: string; body?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ url: req.url, auth: req.headers.authorization as string, body: b }); handler(req, res, b); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2.0`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => { seen.length = 0; });
  const gw = (over: Record<string, unknown> = {}) => new HttpKeepupGateway({ baseUrl: base, apiKey: "sandbox-test-key", environment: "sandbox", timeoutMs: 400, ...over });
  const reply = (status: number, body: unknown, raw = false) => { handler = (_q, res) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(raw ? String(body) : JSON.stringify(body)); }; };

  it("created: a 2xx with a sale id (nested data or flat), link only if https", async () => {
    reply(200, { data: { sale_id: 4711, share_link: "https://keepup.example.invalid/s/4711", status: "unpaid" } });
    expect(await gw().createSale(REQ)).toEqual({ kind: "created", saleId: "4711", link: "https://keepup.example.invalid/s/4711", externalStatus: "unpaid" });
    reply(200, { sale_id: "S-9", link: "http://insecure.example.invalid/x" });
    expect(await gw().createSale(REQ)).toMatchObject({ kind: "created", saleId: "S-9", link: undefined });
  });
  it("sends the bearer key only to the configured base, posts to /sales/add, and puts the Movezz reference in the notes", async () => {
    reply(200, { data: { sale_id: "1" } });
    await gw().createSale(REQ);
    expect(seen[0]).toMatchObject({ url: "/v2.0/sales/add", auth: "Bearer sandbox-test-key" });
    const body = JSON.parse(seen[0].body!);
    expect(body.notes).toContain("ORD-00042"); expect(body.notes).toContain("invoice:abc");
    expect(JSON.parse(body.items)[0]).toMatchObject({ item_id: 1, item_name: "Box", price: 100 });
  });
  it("definite rejections (400/401/403/404/422) are 'rejected' and never leak the response body beyond a short message", async () => {
    for (const st of [400, 401, 403, 404, 422]) {
      reply(st, { error: "invalid phone\nwith newline" });
      const o = await gw().createSale(REQ);
      expect(o.kind).toBe("rejected");
      expect((o as { reason: string }).reason).toContain(String(st));
      expect((o as { reason: string }).reason).not.toMatch(/[\r\n]/);
    }
  });
  it("everything else is AMBIGUOUS: 5xx, 429, 2xx without a sale id, 2xx with garbage, empty body", async () => {
    for (const [st, body, raw] of [[500, {}, false], [502, "<html>bad gateway</html>", true], [503, {}, false], [429, {}, false], [200, {}, false], [200, { data: {} }, false], [200, "not json", true], [201, "", true], [200, { sale_id: "x".repeat(300) }, false]] as const) {
      reply(st, body, raw);
      expect((await gw().createSale(REQ)).kind, `${st} ${String(body).slice(0, 20)}`).toBe("ambiguous");
    }
  });
  it("a timeout is ambiguous (the request may have been processed) and is bounded", async () => {
    handler = () => { /* never answers */ };
    const t0 = Date.now();
    const o = await gw({ timeoutMs: 150 }).createSale(REQ);
    expect(o.kind).toBe("ambiguous");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("a caller-supplied abort is ambiguous too; a closed port is ambiguous (network error)", async () => {
    handler = () => {};
    const ac = new AbortController(); setTimeout(() => ac.abort(), 50);
    expect((await gw({ timeoutMs: 5000 }).createSale(REQ, { signal: ac.signal })).kind).toBe("ambiguous");
    expect((await new HttpKeepupGateway({ baseUrl: "http://127.0.0.1:1/v2.0", apiKey: "sandbox-test-key", environment: "sandbox", timeoutMs: 500 }).createSale(REQ)).kind).toBe("ambiguous");
  });
  it("redirects are never followed (SSRF / credential re-send): ambiguous, and the redirect target is never contacted", async () => {
    let followed = false;
    const other = http.createServer((_q, res) => { followed = true; res.end("{}"); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`;
    handler = (_q, res) => { res.statusCode = 302; res.setHeader("location", target); res.end(); };
    const o = await gw().createSale(REQ);
    await new Promise((r) => other.close(r));
    expect(o.kind).toBe("ambiguous");
    expect(followed).toBe(false);
  });
  it("an oversized response is not buffered without limit", async () => {
    handler = (_q, res) => { res.statusCode = 200; res.end("x".repeat(2_000_000)); };
    expect((await gw({ maxResponseBytes: 1024 }).createSale(REQ)).kind).toBe("ambiguous");
  });
  it("the API key never appears in an outcome", async () => {
    reply(500, { error: "sandbox-test-key leaked?" });
    expect(JSON.stringify(await gw().createSale(REQ))).not.toContain("sandbox-test-key");
  });
});

describe("Keepup base URL safety (SSRF / accidental production)", () => {
  it("refuses the production API host unless production is requested twice", () => {
    expect(() => assertSafeKeepupBaseUrl("https://api.keepup.store/v2.0", "sandbox")).toThrow(/production/);
    expect(() => assertSafeKeepupBaseUrl("https://api.keepup.store/v2.0", "production")).toThrow(/allowProduction/);
    expect(() => assertSafeKeepupBaseUrl("https://api.keepup.store/v2.0", "production", false)).toThrow();
    expect(() => new HttpKeepupGateway({ baseUrl: "https://api.keepup.store/v2.0", apiKey: "k".repeat(12), environment: "sandbox" })).toThrow();
    expect(() => assertSafeKeepupBaseUrl("https://api.keepup.store/v2.0", "production", true)).not.toThrow();   // only reachable by an explicit cutover decision
  });
  it("rejects plain http off localhost, credentials in the URL, query strings, metadata/internal addresses and arbitrary sandbox hosts", () => {
    for (const bad of ["http://sandbox.keepup.invalid/v2.0", "https://user:pw@sandbox.keepup.invalid/", "https://sandbox.keepup.invalid/v2.0?x=1", "https://169.254.169.254/latest", "https://10.0.0.5/v2.0",
                       "https://evil.example.com/v2.0", "ftp://sandbox.keepup.invalid", "not a url", "https://localhost.evil.com/v2.0"]) {
      expect(() => assertSafeKeepupBaseUrl(bad, "sandbox"), bad).toThrow();
    }
    expect(() => assertSafeKeepupBaseUrl("https://sandbox.keepup.invalid/v2.0", "sandbox")).not.toThrow();
    expect(() => assertSafeKeepupBaseUrl("http://127.0.0.1:8080/v2.0", "sandbox")).not.toThrow();
    expect(() => assertSafeKeepupBaseUrl("http://127.0.0.1:8080/v2.0", "production", true)).toThrow();
  });
  it("requires an API key", () => {
    expect(() => new HttpKeepupGateway({ baseUrl: "http://127.0.0.1:1/v2.0", apiKey: "", environment: "sandbox" })).toThrow(/API key/);
  });
});
