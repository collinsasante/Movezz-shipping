/**
 * Cloudflare Pages CI build — same as cf-pages-deploy.mjs but WITHOUT
 * the final `wrangler pages deploy` call. Cloudflare Pages handles
 * deployment itself after this script exits.
 */

import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const STAGING = ".pages-deploy";
const OPENNEXT = ".open-next";

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

const OLD_STATIC = ".old-static-backup";
const prevStatic = join(STAGING, "_next", "static");
if (existsSync(prevStatic)) {
  rmSync(OLD_STATIC, { recursive: true, force: true });
  cpSync(prevStatic, OLD_STATIC, { recursive: true });
  console.log("✅ Backed up previous _next/static for chunk continuity");
}

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

cpSync(join(OPENNEXT, "assets"), STAGING, { recursive: true });

if (existsSync(OLD_STATIC)) {
  mergeOldFiles(OLD_STATIC, join(STAGING, "_next", "static"));
  rmSync(OLD_STATIC, { recursive: true, force: true });
  console.log("✅ Merged old static assets into new build");
}

const workerJs = `
if (typeof WeakRef === "undefined") {
  globalThis.WeakRef = class WeakRef {
    constructor(t) { this._t = t; }
    deref() { return this._t; }
  };
}
if (typeof FinalizationRegistry === "undefined") {
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

    const capturedErrors = [];
    const _origError = console.error;
    console.error = (...args) => {
      capturedErrors.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
      _origError(...args);
    };

    if (serverHandlerError || !serverHandler) {
      return errorPage("Server handler failed to load at startup", serverHandlerError, url);
    }

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

        const reqOrResp = await middlewareHandler(request, env, ctx);
        if (reqOrResp instanceof Response) return reqOrResp;

        let nextResp = await serverHandler(reqOrResp, env, ctx, request.signal);
        const ct = nextResp.headers.get("content-type") ?? "";
        if (ct.includes("text/html")) {
          const h = new Headers(nextResp.headers);
          h.set("Cache-Control", "no-cache, must-revalidate");
          nextResp = new Response(nextResp.body, { status: nextResp.status, statusText: nextResp.statusText, headers: h });
        }
        if (nextResp.status >= 500) {
          const logs = capturedErrors.join("\\n");
          return errorPage(
            "Next.js returned " + nextResp.status + " for " + path,
            "=== SERVER CONSOLE.ERROR LOGS ===\\n" + (logs || "(none captured)"),
            url
          );
        }
        return nextResp;
      });
    } catch (err) {
      return errorPage("Request handler crashed", err, url);
    } finally {
      console.error = _origError;
    }
  },
};
`.trimStart();

writeFileSync(join(STAGING, "_worker.js"), workerJs);
console.log("✅ Generated _worker.js");

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
