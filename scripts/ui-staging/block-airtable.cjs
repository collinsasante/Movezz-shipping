// STAGING HARNESS ONLY. Preloaded into the Next server: any attempt to reach Airtable (fetch, http/https, raw sockets) is refused and
// recorded in $AIRTABLE_BLOCK_LOG (default /tmp/airtable-block.log). A run is "Airtable-free" when that log stays empty.
const fs = require("node:fs"); const net = require("node:net"); const tls = require("node:tls"); const http = require("node:http"); const https = require("node:https");
const LOG = process.env.AIRTABLE_BLOCK_LOG || "/tmp/airtable-block.log";
const RE = /(^|\.)airtable(usercontent)?\.com$/i;
const hit = (what, host) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${what} ${host}\n`); } catch {} throw new Error(`Airtable is unreachable (harness): ${host}`); };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; try { if (RE.test(new URL(u).hostname)) hit("fetch", new URL(u).hostname); } catch (e) { if (/Airtable is unreachable/.test(e.message)) throw e; } return realFetch(input, init); };
for (const m of [http, https]) { const r = m.request; m.request = function (a, b, c) { const h = typeof a === "string" ? new URL(a).hostname : a instanceof URL ? a.hostname : (a.hostname || a.host || ""); if (RE.test(h)) hit("http", h); return r.call(this, a, b, c); }; }
for (const [m, k] of [[net, "connect"], [tls, "connect"]]) { const c = m[k]; m[k] = function (...args) { const o = args[0]; const h = typeof o === "object" ? (o.host || o.servername || "") : ""; if (RE.test(h)) hit(k, h); return c.apply(this, args); }; }
