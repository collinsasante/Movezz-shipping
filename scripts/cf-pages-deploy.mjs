/**
 * Cloudflare Pages deploy — with diagnostics.
 *
 * Strategy: Load server-functions/default/handler.mjs via a top-level
 * `await import()` wrapped in try-catch. If it fails at init time the whole
 * worker would normally crash silently; with the try-catch we store the error
 * and return it visibly in every HTTP response instead.
 */

import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const STAGING = ".pages-deploy";
const OPENNEXT = ".open-next";

// Merge src → dest, skipping files that already exist in dest (old files fill gaps)
function mergeOldFiles(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) mergeOldFiles(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

console.log("🏗  Preparing Cloudflare Pages deploy directory...");

// Preserve previous static assets so browsers with cached old HTML can still
// find their old chunk/CSS files without needing a hard refresh.
const OLD_STATIC = ".old-static-backup";
const prevStatic = join(STAGING, "_next", "static");
if (existsSync(prevStatic)) {
  rmSync(OLD_STATIC, { recursive: true, force: true });
  cpSync(prevStatic, OLD_STATIC, { recursive: true });
  console.log("✅ Backed up previous _next/static for chunk continuity");
}

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

// Static assets
cpSync(join(OPENNEXT, "assets"), STAGING, { recursive: true });

// Merge old static files back — new files take precedence, old fill the gaps
if (existsSync(OLD_STATIC)) {
  mergeOldFiles(OLD_STATIC, join(STAGING, "_next", "static"));
  rmSync(OLD_STATIC, { recursive: true, force: true });
  console.log("✅ Merged old static assets into new build");
}

// Write _worker.js — uses top-level await import() inside try-catch so any
// module-init error is captured and returned as an HTTP response (visible
// in the browser) instead of silently crashing the worker.
const workerJs = `
// ── Polyfill WeakRef / FinalizationRegistry ────────────────────────────────────
// undici (bundled inside handler.mjs) uses these lazily during React rendering.
// Miniflare's sandbox doesn't expose them; production Workers may lack
// FinalizationRegistry. Set polyfills before any module is loaded.
if (typeof WeakRef === "undefined") {
  console.log("[worker] polyfilling WeakRef");
  globalThis.WeakRef = class WeakRef {
    constructor(t) { this._t = t; }
    deref() { return this._t; }
  };
}
if (typeof FinalizationRegistry === "undefined") {
  console.log("[worker] polyfilling FinalizationRegistry");
  globalThis.FinalizationRegistry = class FinalizationRegistry {
    constructor() {}
    register() {}
    unregister() {}
  };
}

import { handleCdnCgiImageRequest, handleImageRequest } from "./cloudflare/images.js";
import { runWithCloudflareRequestContext } from "./cloudflare/init.js";
import { maybeGetSkewProtectionResponse } from "./cloudflare/skew-protection.js";
import { handler as middlewareHandler } from "./middleware/handler.mjs";

export { DOQueueHandler } from "./.build/durable-objects/queue.js";
export { DOShardedTagCache } from "./.build/durable-objects/sharded-tag-cache.js";
export { BucketCachePurge } from "./.build/durable-objects/bucket-cache-purge.js";

// ── Load server handler — catch init errors so the worker doesn't crash ───────
let serverHandler = null;
let serverHandlerError = null;
try {
  const mod = await import("./server-functions/default/handler.mjs");
  serverHandler = mod.handler;
  console.log("[worker] server handler loaded OK");
} catch (err) {
  serverHandlerError = err;
  console.error("[worker] FAILED to load server handler:", String(err));
}

function errorPage(label, err, url) {
  const e = String(err).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  const s = (err && err.stack ? err.stack : "(no stack)").replace(/&/g,"&amp;").replace(/</g,"&lt;");
  return new Response(
    "<html><body style='background:#ff0;font-family:monospace;padding:30px'>" +
    "<h1 style='color:red'>WORKER ERROR — paste this to Claude</h1>" +
    "<b>" + label + "</b><br>URL: " + url +
    "<pre style='background:#fff;padding:20px;margin-top:10px;border:2px solid red'>" +
    e + "\\n\\n" + s + "</pre></body></html>",
    { status: 500, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = request.url;
    const path = new URL(url).pathname;
    console.log("[worker] request:", request.method, path,
      "| handler loaded:", serverHandler !== null,
      "| handlerErr:", serverHandlerError ? String(serverHandlerError) : "none"
    );

    // Intercept console.error so we can surface Next.js internal errors
    const capturedErrors = [];
    const _origError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
      _origError(...args);
    };

    // If server handler failed to load, show that error immediately
    if (serverHandlerError || !serverHandler) {
      return errorPage("Server handler failed to load at startup", serverHandlerError, url);
    }

    // ── Serve static assets via ASSETS binding ────────────────────────────────
    // In Pages advanced mode (_worker.js) ALL requests go to the worker.
    // Static files must be fetched explicitly from env.ASSETS.
    // IMPORTANT: Only try ASSETS for GET/HEAD — ASSETS returns 405 for POST/etc.
    // Only serve if response is 2xx (not 404/405/other errors).
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      const assetResp = await env.ASSETS.fetch(request.clone()).catch(() => null);
      if (assetResp && (assetResp.ok || assetResp.status === 304)) return assetResp;
    }

    try {
      return await runWithCloudflareRequestContext(request, env, ctx, async () => {
        const skew = maybeGetSkewProtectionResponse(request);
        if (skew) return skew;

        const u = new URL(request.url);
        if (u.pathname.startsWith("/cdn-cgi/image/")) return handleCdnCgiImageRequest(u, env);
        const imgPath = (globalThis.__NEXT_BASE_PATH__ || "") + "/_next/image" + (globalThis.__TRAILING_SLASH__ ? "/" : "");
        if (u.pathname === imgPath) return await handleImageRequest(u, request.headers, env);

        console.log("[worker] running middleware for", path);
        const reqOrResp = await middlewareHandler(request, env, ctx);
        if (reqOrResp instanceof Response) {
          console.log("[worker] middleware =>", reqOrResp.status);
          return reqOrResp;
        }

        console.log("[worker] calling server handler");
        let nextResp = await serverHandler(reqOrResp, env, ctx, request.signal);
        // Prevent browsers from caching HTML pages — stale HTML causes chunk 404s after redeploy
        const ct = nextResp.headers.get("content-type") ?? "";
        if (ct.includes("text/html")) {
          const h = new Headers(nextResp.headers);
          h.set("Cache-Control", "no-cache, must-revalidate");
          nextResp = new Response(nextResp.body, { status: nextResp.status, statusText: nextResp.statusText, headers: h });
        }
        if (nextResp.status >= 500) {
          const logs = capturedErrors.join("\\n");
          console.error("[worker] Next.js returned", nextResp.status, "for", path);
          return errorPage(
            "Next.js returned " + nextResp.status + " for " + path,
            "=== SERVER CONSOLE.ERROR LOGS ===\\n" + (logs || "(none captured)"),
            url
          );
        }
        return nextResp;
      });
    } catch (err) {
      console.error("[worker] request crash:", String(err));
      return errorPage("Request handler crashed", err, url);
    } finally {
      console.error = _origError;
    }
  },
};
`.trimStart();

writeFileSync(join(STAGING, "_worker.js"), workerJs);
console.log("✅ Generated diagnostic _worker.js");

// _headers — prevent browsers from caching HTML pages between deployments.
// Static chunks are content-addressed so they can be cached forever.
writeFileSync(join(STAGING, "_headers"), `\
/*
  Cache-Control: no-cache, must-revalidate

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
`);

for (const dir of ["cloudflare", "middleware", "server-functions", ".build", "cloudflare-templates"]) {
  const src = join(OPENNEXT, dir);
  if (existsSync(src)) cpSync(src, join(STAGING, dir), { recursive: true });
}

console.log("✅ Staging ready:", STAGING);
console.log("🚀 Deploying...\n");
execSync("/usr/local/bin/node node_modules/.bin/wrangler pages deploy", { stdio: "inherit" });
