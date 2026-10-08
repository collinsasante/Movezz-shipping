// Open redirects, cross-site cookie requests, security headers and cookie attributes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { standardWorld } from "../helpers/world";
import { readSource } from "../helpers/sourceFn";
import { FIXED, PRESERVE, KNOWN_BUG } from "../helpers/known";

describe(FIXED("post-login redirects accept same-site paths only"), () => {
  const fb = "/admin";
  it.each([
    ["/admin/orders", "/admin/orders"],
    ["/customer/items?page=2#top", "/customer/items?page=2#top"],
    ["/", "/"],
  ])("accepts %s", (input, out) => expect(safeRedirectPath(input, fb)).toBe(out));

  it.each([
    "//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "\\/evil.example",
    "https://evil.example", "http://evil.example/x", "javascript:alert(1)", "data:text/html,x", "evil.example",
    "/\tevil.example", "/\nevil.example", "/%0d%0aSet-Cookie:x", " //evil.example", "", "/ok\\..\\evil",
  ])("rejects %j", (input) => {
    const out = safeRedirectPath(input, fb);
    if (input === "/%0d%0aSet-Cookie:x") expect(out.startsWith("/")).toBe(true); // percent-encoded text stays inside the path
    else expect(out).toBe(fb);
  });
  it("null/undefined use the fallback", () => {
    expect(safeRedirectPath(null, fb)).toBe(fb);
    expect(safeRedirectPath(undefined, fb)).toBe(fb);
  });
  it("source anchor: the login page uses the helper (no private startsWith check)", () => {
    const src = readSource("src/app/(auth)/login/page.tsx");
    expect(src).toContain("safeRedirectPath(redirect, defaultPath)");
    expect(src).not.toContain('redirect.startsWith("/")');
  });
});

describe(FIXED("a cookie-authenticated state-changing request from another origin is refused"), () => {
  async function cookieCall(origin: string | undefined, method: "POST" | "GET" = "POST") {
    const { w, admin } = await standardWorld();
    return w.call("warehouses", method, {
      token: admin,
      viaCookie: true,
      body: method === "POST" ? { name: "X", address: "Y" } : undefined,
      headers: { host: "app.movezz.example", ...(origin ? { origin } : {}) },
    });
  }
  it("foreign Origin + cookie + POST -> 403", async () => {
    const res = await cookieCall("https://evil.example");
    expect(res.status).toBe(403);
    expect(res.json?.error).toMatch(/Cross-site/);
  });
  it("Origin 'null' is refused as well", async () => {
    expect((await cookieCall("null")).status).toBe(403);
  });
  it("same Origin + cookie + POST is accepted", async () => {
    expect((await cookieCall("https://app.movezz.example")).status).not.toBe(403);
  });
  it("no Origin header (non-browser client) is not affected", async () => {
    expect((await cookieCall(undefined)).status).not.toBe(403);
  });
  it("GET with a foreign Origin is not a state change and is not refused", async () => {
    expect((await cookieCall("https://evil.example", "GET")).status).toBe(200);
  });
  it("a Bearer token cannot be attached by a foreign site, so it is not subject to the check", async () => {
    const { w, admin } = await standardWorld();
    const res = await w.call("warehouses", "POST", { token: admin, body: { name: "X", address: "Y" }, headers: { origin: "https://evil.example", host: "app.movezz.example" } });
    expect(res.status).not.toBe(403);
  });
});

describe("headers and cookies", () => {
  const require = createRequire(import.meta.url);
  it(FIXED("next.config.js sends HSTS (without includeSubDomains/preload)"), async () => {
    const cfg = require("../../next.config.js") as { headers: () => Promise<{ headers: { key: string; value: string }[] }[]> };
    const all = (await cfg.headers()).flatMap((h) => h.headers);
    expect(all.find((h) => h.key === "Strict-Transport-Security")?.value).toBe("max-age=31536000");
    expect(all.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
    expect(all.find((h) => h.key === "X-Content-Type-Options")?.value).toBe("nosniff");
    expect(all.find((h) => h.key === "Content-Security-Policy")?.value).toContain("object-src 'none'");
  });
  it(PRESERVE("the session cookie is HttpOnly, Secure and SameSite=Strict (source anchor)"), () => {
    const src = readSource("src/app/api/auth/verify/route.ts");
    expect(src).toContain("HttpOnly; Secure; SameSite=Strict");
  });
  it(KNOWN_BUG("CSP still allows 'unsafe-inline' and 'unsafe-eval' scripts, and two different policies are sent (next.config.js and middleware.ts)"), () => {
    // Needs nonce/hash plumbing and testing against Firebase/Google sign-in in a browser; not changed blindly. See docs/SECURITY-BASELINE.md.
    expect(readSource("next.config.js")).toContain("'unsafe-eval'");
    expect(readSource("src/middleware.ts")).toContain("'unsafe-eval'");
  });
});

describe(FIXED("expensive endpoints are rate limited per user"), () => {
  it("create-invoice: 10 per minute per admin", async () => {
    const { w, admin } = await standardWorld();
    w.seed.settings(12.5);
    w.seed.order("recO1", "recCustA", { Status: "Pending" });
    for (let i = 0; i < 10; i++) expect((await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: "recO1" }, body: {} })).status).not.toBe(429);
    expect((await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: "recO1" }, body: {} })).status).toBe(429);
  });
  it("keepup-sync: 6 per minute", async () => {
    const { w, admin } = await standardWorld();
    for (let i = 0; i < 6; i++) expect((await w.call("orders/keepup-sync", "POST", { token: admin })).status).toBe(200);
    expect((await w.call("orders/keepup-sync", "POST", { token: admin })).status).toBe(429);
  });
  it("reports: 30 per minute", async () => {
    const { w, admin } = await standardWorld();
    for (let i = 0; i < 30; i++) expect((await w.call("reports", "GET", { token: admin })).status).not.toBe(429);
    expect((await w.call("reports", "GET", { token: admin })).status).toBe(429);
  });
  it(KNOWN_BUG("limits are per isolate/instance and keyed on a spoofable header off Cloudflare; Cloudflare rate-limiting rules are required in production"), async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    expect(checkRateLimit("k", 1, 1000)).toBe(true);
    expect(checkRateLimit("k", 1, 1000)).toBe(false);
  });
});
