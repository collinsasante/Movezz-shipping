// The REAL src/lib/keepup.ts (the global mock from tests/setup/setup.ts is bypassed with importActual)
// running against a stubbed fetch. Documents the exact wire format the production code sends today.
// NOTE: Keepup's own documentation is not reachable from this environment, so everything below is the
// behavior of OUR client, not a verified statement about Keepup's server (idempotency, webhooks: UNVERIFIED).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

type K = typeof import("@/lib/keepup");
type Call = { url: string; init: RequestInit; json: Record<string, any> | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any

let calls: Call[];
function stubFetch(...responses: { status?: number; body?: unknown }[]) {
  calls = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200, body: {} };
    calls.push({ url: String(url), init: init ?? {}, json: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
}
const load = () => vi.importActual<K>("@/lib/keepup");
const okSale = { status: 200, body: { data: { sale_id: 4242, share_link: "https://keepup.example.invalid/share/4242" } } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-15T10:00:00.000Z"));
});

describe("createKeepupSale: request format", () => {
  it(PRESERVE("POSTs to /v2.0/sales/add with a Bearer key and the invoice payload (items as a JSON STRING)"), async () => {
    stubFetch(okSale);
    const k = await load();
    const res = await k.createKeepupSale({
      customerName: "Ada Mensah", customerEmail: "ada@example.invalid", customerPhone: "0244001234", invoiceDate: "2026-03-10",
      items: [{ item_name: "Laptop", quantity: 1, price: 1250, item_type: "product" }, { item_name: "Shoes", quantity: 1, price: 300, item_type: "product" }],
    });
    expect(res).toEqual({ saleId: "4242", link: "https://keepup.example.invalid/share/4242" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.keepup.store/v2.0/sales/add");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ Authorization: "Bearer test-only-keepup-key", "Content-Type": "application/json" });
    const body = calls[0].json!;
    expect(typeof body.items).toBe("string");
    expect(JSON.parse(body.items)).toEqual([
      { item_id: 1, item_name: "Laptop", quantity: 1, price: 1250, item_type: "product" },
      { item_id: 2, item_name: "Shoes", quantity: 1, price: 300, item_type: "product" },
    ]);
    expect(body).toMatchObject({
      payment_type: "bank_transfer", amount_received: "0", alert_customer: "yes",
      issue_date: "2026-03-10 00:00", due_date: "2026-04-09 00:00", // due = issue + 30 days
      customer_name: "Ada Mensah", customer_email: "ada@example.invalid", phone_number: "+233244001234",
    });
  });

  it(PRESERVE("normalizes phone numbers to E.164 (0xxxxxxxxx -> +233..., 233... -> +233..., 10+ digits -> +digits) and omits unusable ones"), async () => {
    const phones: [string | undefined, string | undefined][] = [
      ["0244001234", "+233244001234"], ["233244001234", "+233244001234"], ["+1 415 555 2671", "+14155552671"], ["12345", undefined], [undefined, undefined],
    ];
    for (const [input, expected] of phones) {
      stubFetch(okSale);
      await (await load()).createKeepupSale({ customerPhone: input, items: [{ item_name: "x", quantity: 1, price: 1, item_type: "product" }] });
      expect(calls[0].json?.phone_number, String(input)).toBe(expected);
    }
  });

  it(PRESERVE("sends customer_email only when it contains '@'; always sends alert_customer 'yes' (Keepup notifies the customer)"), async () => {
    stubFetch(okSale);
    await (await load()).createKeepupSale({ customerEmail: "not-an-email", items: [{ item_name: "x", quantity: 1, price: 1, item_type: "product" }] });
    expect(calls[0].json).not.toHaveProperty("customer_email");
    expect(calls[0].json?.alert_customer).toBe("yes");
  });

  it(PRESERVE("reads the sale id from either the nested 'data' object or the response root, and the link from share_link or link"), async () => {
    stubFetch({ body: { sale_id: "S-9", link: "https://keepup.example.invalid/root" } });
    const res = await (await load()).createKeepupSale({ items: [{ item_name: "x", quantity: 1, price: 1, item_type: "product" }] });
    expect(res).toEqual({ saleId: "S-9", link: "https://keepup.example.invalid/root" });
  });
});

describe(KNOWN_BUG("createKeepupSale failure handling and idempotency"), () => {
  // Future behavior (Phase 3 R-22): stored idempotency key, sync state, bounded retries, reconciliation.
  // These tests document OUR client's current behavior only.
  const items = [{ item_name: "x", quantity: 1, price: 1, item_type: "product" }];

  it("documents that ANY failed response (even 500) triggers an immediate second request without the phone number - a possible duplicate sale", async () => {
    stubFetch({ status: 500, body: { error: "boom" } }, okSale);
    const res = await (await load()).createKeepupSale({ customerPhone: "0244001234", items });
    expect(res.saleId).toBe("4242");
    expect(calls).toHaveLength(2);
    expect(calls[0].json).toHaveProperty("phone_number");
    expect(calls[1].json).not.toHaveProperty("phone_number");
  });
  it("documents that no idempotency key is ever sent and no request timeout/abort signal is set", async () => {
    stubFetch(okSale);
    await (await load()).createKeepupSale({ items });
    expect(Object.keys(calls[0].init.headers as Record<string, string>).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(calls[0].init.signal).toBeUndefined();
  });
  it("documents that no retry happens when there is no phone number to drop (one attempt, then throw the upstream message)", async () => {
    stubFetch({ status: 422, body: { error: "invalid items" } });
    await expect((await load()).createKeepupSale({ items })).rejects.toThrow("invalid items");
    expect(calls).toHaveLength(1);
  });
  it("falls back to a generic message when the error body has no text", async () => {
    stubFetch({ status: 502, body: {} });
    await expect((await load()).createKeepupSale({ items })).rejects.toThrow("Keepup API error 502");
  });
  it("throws when a 200 response carries no sale id", async () => {
    stubFetch({ status: 200, body: { data: {} } });
    await expect((await load()).createKeepupSale({ items })).rejects.toThrow(/did not return a sale ID/);
  });
  it("throws a clear error when KEEPUP_API_KEY is missing", async () => {
    const saved = process.env.KEEPUP_API_KEY;
    delete process.env.KEEPUP_API_KEY;
    try {
      stubFetch(okSale);
      await expect((await load()).createKeepupSale({ items })).rejects.toThrow("KEEPUP_API_KEY is not set");
    } finally {
      process.env.KEEPUP_API_KEY = saved;
    }
  });
});

describe("reading and updating sales", () => {
  it(PRESERVE("getKeepupSale parses totals/paid/balance from nested or root fields and returns the share link"), async () => {
    stubFetch({ body: { data: { total_amount: "1250.50", amount_paid: "250", balance_due: "1000.50", share_link: "https://keepup.example.invalid/s" } } });
    expect(await (await load()).getKeepupSale("S-1")).toEqual({ totalAmount: 1250.5, amountPaid: 250, balanceDue: 1000.5, shareLink: "https://keepup.example.invalid/s" });
    expect(calls[0].url).toBe("https://api.keepup.store/v2.0/sales/S-1");
  });
  it(PRESERVE("derives the balance when Keepup omits it, and treats an unreadable paid amount as 0"), async () => {
    stubFetch({ body: { total_amount: 100, amount_paid: "n/a" } });
    expect(await (await load()).getKeepupSale("S-1")).toMatchObject({ totalAmount: 100, amountPaid: 0, balanceDue: 100 });
  });
  it(PRESERVE("throws when no total can be read (so callers never mark an order Paid on a malformed reply)"), async () => {
    stubFetch({ body: { data: {} } });
    await expect((await load()).getKeepupSale("S-1")).rejects.toThrow(/missing total_amount/);
  });
  it(KNOWN_BUG("a sale whose total is 0 (e.g. a 100% discount) cannot be read: 0 is treated as 'missing'"), async () => {
    stubFetch({ body: { data: { total_amount: "0", amount_paid: "0" } } });
    await expect((await load()).getKeepupSale("S-1")).rejects.toThrow(/missing total_amount/);
  });
  it(PRESERVE("fetchKeepupShareLink never throws (null on any failure)"), async () => {
    stubFetch({ status: 500, body: {} });
    expect(await (await load()).fetchKeepupShareLink("S-1")).toBeNull();
  });
  it(PRESERVE("recordKeepupPayment PUTs /sales/balance/{id} with the amount as a string and today's date"), async () => {
    stubFetch({ body: {} });
    await (await load()).recordKeepupPayment("S-1", 30);
    expect(calls[0].url).toBe("https://api.keepup.store/v2.0/sales/balance/S-1");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].json).toEqual({ amount_paid: "30", payment_type: "bank_transfer", date: "2026-03-15 00:00", alert_customer: "yes" });
  });
  it(PRESERVE("cancel and refund PUT with alert_customer 'no'; failures throw the upstream message"), async () => {
    stubFetch({ body: {} }, { body: {} }, { status: 400, body: { error: "already cancelled" } });
    const k = await load();
    await k.cancelKeepupSale("S-1");
    await k.refundKeepupSale("S-1");
    expect(calls.map((c) => [c.init.method, c.url, c.json])).toEqual([
      ["PUT", "https://api.keepup.store/v2.0/sales/cancel/S-1", { alert_customer: "no" }],
      ["PUT", "https://api.keepup.store/v2.0/sales/refund/S-1", { alert_customer: "no" }],
    ]);
    await expect(k.cancelKeepupSale("S-1")).rejects.toThrow("already cancelled");
  });
  it(PRESERVE("updateKeepupSale sends only the fields supplied, with items as a JSON string"), async () => {
    stubFetch({ body: {} });
    await (await load()).updateKeepupSale("S-1", { invoiceDate: "2026-04-01", items: [{ item_name: "x", quantity: 1, price: 5, item_type: "product" }] });
    expect(calls[0].url).toBe("https://api.keepup.store/v2.0/sales/edit/S-1");
    expect(calls[0].json).toMatchObject({ issue_date: "2026-04-01 00:00", due_date: "2026-05-01 00:00" });
    expect(JSON.parse(calls[0].json!.items)).toEqual([{ item_id: 1, item_name: "x", quantity: 1, price: 5, item_type: "product" }]);
    expect(calls[0].json).not.toHaveProperty("customer_name");
  });
});
