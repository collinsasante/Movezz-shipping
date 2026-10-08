// STAGING HARNESS ONLY: drives the real UI (Chromium) against the PostgreSQL-backed app started by scripts/ui-staging/start.sh.
// usage: PLAYWRIGHT_CORE_DIR=/path/to/node_modules/playwright-core node scripts/ui-staging/ui-run.mjs [crawl|flow]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE_DIR ?? "playwright-core");
const BASE = "http://localhost:3100";
const mode = process.argv[2] ?? "crawl";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const findings = [];

async function session(email, password) {
  const ctx = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 250)}` } });   // each harness user gets its own rate-limit bucket
  // the browser's Firebase SDK talks to Google; the harness answers those calls from the local stand-in (no network, no real Firebase project)
  await ctx.route(/^https:\/\/(identitytoolkit|securetoken)\.googleapis\.com\//, async (route) => {
    const u = new URL(route.request().url());
    let r; try { r = await fetch(`http://127.0.0.1:9199${u.pathname}${u.search}`, { method: route.request().method(), headers: { "content-type": "application/json" }, body: route.request().method() === "POST" ? route.request().postData() ?? undefined : undefined }); } catch { return route.abort(); }
    await route.fulfill({ status: r.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await r.text() });
  });
  const page = await ctx.newPage();
  const log = { api: [], errors: [], role: email };
  page.on("response", (r) => { const u = r.url(); if (u.includes("/api/") && r.status() >= 400) log.api.push(`${r.request().method()} ${new URL(u).pathname} -> ${r.status()}`); });
  page.on("pageerror", (e) => log.errors.push(String(e.message).slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) log.errors.push(m.text().slice(0, 120)); });
  await page.goto("/login");
  await page.fill('input[type="email"]', email);
  await page.fill('input[placeholder="Enter your password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
  return { ctx, page, log };
}
async function visit(s, path) {
  const before = s.log.api.length, eb = s.log.errors.length;
  await s.page.goto(path, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  const text = (await s.page.locator("body").innerText().catch(() => "")).slice(0, 4000);
  const broken = /Application error|Something went wrong|Unhandled Runtime Error|This page could not be found/i.test(text);
  return { path, url: new URL(s.page.url()).pathname, apiErrors: s.log.api.slice(before), jsErrors: s.log.errors.slice(eb), broken, chars: text.length };
}
export { browser, session, visit, findings, BASE };

if (mode === "crawl" && process.argv[1].endsWith("ui-run.mjs")) {
  const plans = {
    "admin@example.invalid": ["/admin", "/admin/customers", "/admin/items", "/admin/containers", "/admin/orders", "/admin/reports", "/admin/settings", "/admin/suppliers", "/admin/staff", "/admin/registrations", "/admin/sorting", "/admin/repacking", "/admin/calculator", "/admin/customers/new", "/admin/items/new", "/admin/containers/new", "/admin/orders/new", "/admin/suppliers/new"],
    "staff@example.invalid": ["/admin", "/admin/customers", "/admin/items", "/admin/containers", "/admin/orders", "/admin/reports", "/admin/settings", "/admin/staff", "/admin/sorting", "/admin/items/new"],
    "ama@example.invalid": ["/customer", "/customer/items", "/customer/orders", "/customer/tracking", "/customer/addresses", "/customer/settings", "/customer/calculator", "/admin", "/admin/orders"],
  };
  for (const [email, paths] of Object.entries(plans)) {
    if (process.env.ONLY && !email.startsWith(process.env.ONLY)) continue;
    const s = await session(email, "pw-" + email.split("@")[0].replace("admin", "admin"));
    console.log(`\n## ${email}  (landed on ${new URL(s.page.url()).pathname})`);
    for (const p of paths) { const r = await visit(s, p); console.log(JSON.stringify(r)); }
    await s.ctx.close();
  }
  await browser.close();
}

if (mode === "flow") {
  const assert = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? "  " + extra : ""}`); if (!ok) findings.push(what); };
  const body = async (p) => (await p.locator("body").innerText()).replace(/\s+/g, " ");
  const admin = await session("admin@example.invalid", "pw-admin"); const p = admin.page;
  const api = (s, m, u, b) => s.page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }, [m, u, b]);

  // 1. invoice through the real form
  await p.goto("/admin/orders/new", { waitUntil: "networkidle" });
  await p.fill('input[placeholder^="Search by name"]', "AO0111"); await p.getByText("Ama Owusu").first().click(); await p.waitForTimeout(1200);
  for (const n of [1, 2, 3]) await p.getByText(`Ama box ${n}`).first().click();
  assert((await p.locator('input[placeholder^="Select items to auto"]').inputValue()).includes("1050.00"), "invoice form sums the server-priced items (3 x $350)");
  await p.getByRole("button", { name: /Generate Invoice/ }).click();
  await p.waitForURL(/\/admin\/orders\/[0-9a-f-]{36}/, { timeout: 20000 });
  const orderId = new URL(p.url()).pathname.split("/").pop();
  await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(800);
  let t = await body(p);
  assert(t.includes("GHS 13,125.00"), "order page shows the frozen GHS total (1050 x 12.5)");
  assert(t.includes("Created by admin@example.invalid"), "order page shows the creator's e-mail, not an internal id");
  assert(!/Invoice Total GHS 13,125\.00 0 /.test(t), "no stray 0 under the totals");
  assert(t.includes("Amount Paid") && t.includes("Balance Due"), "payment panel is visible for a PostgreSQL order");

  // 2. payment, double-clicked: exactly one payment
  await p.getByRole("button", { name: "Record Payment" }).click(); await p.waitForTimeout(400);
  console.log("dialog inputs:", await p.locator("[role=dialog] input").evaluateAll((e) => e.map((x) => `${x.type}:${x.placeholder}`)));
  await p.locator("[role=dialog] input").first().fill("5000");
  const save = p.getByRole("button", { name: "Save Payment" });
  await Promise.all([save.click({ timeout: 4000 }).catch(() => {}), save.click({ force: true, timeout: 4000 }).catch(() => {}), save.dblclick({ force: true, timeout: 4000 }).catch(() => {})]);   // the 2nd/3rd clicks hit a disabled or detached button
  await p.waitForTimeout(1500); await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(800);
  t = await body(p);
  const o = (await api(admin, "GET", `/api/orders/${orderId}`)).body.data;
  assert(o.amountPaid === 5000, "double-clicked payment recorded once", `amountPaid=${o.amountPaid}`);
  assert(t.includes("Partial") && t.includes("GHS 8,125.00"), "page shows Partial and the GHS 8,125.00 balance");

  // 3. settle the rest
  await p.getByRole("button", { name: "Record Payment" }).click(); await p.locator("[role=dialog] input").first().fill("8125");
  await p.getByRole("button", { name: "Save Payment" }).click(); await p.waitForTimeout(1500); await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(800);
  t = await body(p); assert(t.includes("Status Paid") && t.includes("Payment confirmed"), "fully paid order shows Paid and the confirmation");   // (the Record Payment button is always shown, as in Airtable mode; the server refuses overpayment)

  // 4. status transitions, dashboard and report
  const items = (await api(admin, "GET", `/api/items?orderId=${orderId}`)).body.data;
  for (const it of items) for (const st of ["Shipped to Ghana"]) { const r = await api(admin, "PATCH", `/api/items/${it.id}/status`, { status: st }); if (r.status !== 400) assert(false, "shipping without a container is refused", String(r.status)); }
  assert(true, "items cannot ship without a container (400, as in Airtable mode)");
  await p.goto("/admin", { waitUntil: "networkidle" }); await p.waitForTimeout(800); t = await body(p);
  assert(/1,?050/.test(t) || t.includes("1050"), "admin dashboard shows revenue", t.slice(t.indexOf("Revenue") - 20, t.indexOf("Revenue") + 80));
  await p.goto("/admin/reports", { waitUntil: "networkidle" }); await p.waitForTimeout(800); t = await body(p);
  assert(/1,?050/.test(t), "report shows paid revenue");

  // 4b. cancellation through the real screen: unpaid invoice -> Delete -> items are released
  const kojoCust = (await api(admin, "GET", "/api/customers")).body.data.find((c) => c.name === "Kojo Mensah");
  const kitem = (await api(admin, "GET", `/api/items?customerId=${kojoCust.id}`)).body.data[0];
  const o2 = (await api(admin, "POST", "/api/orders", { customerId: kojoCust.id, itemIds: [kitem.id] })).body.data;
  await p.goto(`/admin/orders/${o2.id}`, { waitUntil: "networkidle" }); await p.waitForTimeout(600);
  await p.getByRole("button", { name: "Delete" }).first().click(); await p.waitForTimeout(500);
  console.log("confirm buttons:", await p.locator("[role=dialog] button, button").evaluateAll((e) => e.map((x) => x.innerText.trim()).filter(Boolean).slice(-6)));
  await p.getByRole("button", { name: /^(Delete|Yes|Confirm|Cancel Invoice|Delete Invoice)/ }).last().click(); await p.waitForTimeout(2000);
  const after = await api(admin, "GET", `/api/items/${kitem.id}`);
  assert(after.body.data.orderId === undefined, "cancelling from the screen releases the item", JSON.stringify({ orderId: after.body.data.orderId }));
  assert((await api(admin, "GET", `/api/orders/${o2.id}`)).body.data.status === "Cancelled", "invoice is kept as Cancelled (never physically deleted)");

  // 5. customer isolation in the UI
  const ama = await session("ama@example.invalid", "pw-ama");
  await ama.page.goto("/customer/orders", { waitUntil: "networkidle" }); await ama.page.waitForTimeout(800);
  assert((await body(ama.page)).includes("ORD-00001"), "customer sees own invoice");
  await ama.page.goto(`/customer/orders/${orderId}`, { waitUntil: "networkidle" }); await ama.page.waitForTimeout(800);
  assert((await body(ama.page)).includes("ORD-00001"), "customer opens own invoice");
  const kojo = await session("kojo@example.invalid", "pw-kojo");
  await kojo.page.goto(`/customer/orders/${orderId}`, { waitUntil: "networkidle" }); await kojo.page.waitForTimeout(800);
  const kt = await body(kojo.page); assert(!kt.includes("Ama Owusu") && !kt.includes("13,125"), "another customer cannot see it", kt.slice(0, 120));
  assert((await api(kojo, "GET", `/api/orders/${orderId}`)).status === 404, "API answers 404 for the other customer's invoice");
  console.log("API errors seen by admin:", admin.log.api, "JS:", admin.log.errors, "| customer:", ama.log.api, ama.log.errors);
  console.log(findings.length ? `\nFAILED: ${findings.length}` : "\nALL UI CHECKS PASSED");
  await browser.close();
}
