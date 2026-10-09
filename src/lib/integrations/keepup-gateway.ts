// Keepup gateway for the PostgreSQL-backed sync worker (Phase 7H).
//
// This is NOT the live client (src/lib/keepup.ts, used by the Airtable-backed application, unchanged). It exists so the worker is
// written against an interface: tests and staging use MockKeepupGateway or an HTTP stub; a real Keepup account is only ever wired
// in by an explicit, separate cutover decision (Phase 7I). Nothing in this module reads KEEPUP_API_KEY or any other ambient secret:
// the caller passes the configuration, and the constructor REFUSES the production API host unless production is requested
// explicitly twice (environment + allowProduction).
//
// Outcome model (docs/DECISIONS.md D14: "an HTTP request being sent never proves success"):
//   created    the response is a success AND carries a sale id                      -> the only outcome that makes a row 'synced'
//   rejected   Keepup definitively refused the request (400/401/403/404/422)         -> nothing was created; safe to retry later
//   ambiguous  anything else: timeout, network error, 5xx, 429, 2xx without a sale id, unparsable body, redirect
//              -> the sale MAY exist. It is NEVER retried automatically; it goes to reconciliation.
// Keepup documents no idempotency key and no lookup-by-reference, so none is sent as a header; the Movezz reference and idempotency
// key are written into the sale notes purely as a human reconciliation aid.

export interface KeepupSaleRequest {
  /** Movezz invoice reference, e.g. ORD-00042 */
  reference: string;
  /** The sync row's idempotency key (`invoice:<uuid>`), included in the notes for manual reconciliation. */
  idempotencyKey: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  invoiceDate?: string;               // YYYY-MM-DD
  items: { item_name: string; quantity: number; price: number }[];
}

export type KeepupCreateOutcome =
  | { kind: "created"; saleId: string; link?: string; externalStatus?: string }
  | { kind: "rejected"; reason: string }
  | { kind: "ambiguous"; reason: string };

/** Payment recorded against an EXISTING sale (PUT /sales/balance/{sale}); the amount is this payment only, in GHS (as in the live client). */
export interface KeepupPaymentRequest { saleId: string; amountGhs: string; paidOn: string /* YYYY-MM-DD */; reference: string; idempotencyKey: string }
export interface KeepupCancelRequest { saleId: string; reference: string; idempotencyKey: string }
/**
 * Outcome of a non-creating operation. Keepup returns no identifier for these, so success is "a 2xx".
 *   applied    2xx                                                                  -> the only outcome that makes a row 'synced'
 *   rejected   400/401/403/404/422: Keepup definitively refused; nothing was applied -> failed, bounded retry
 *   ambiguous  timeout, network error, 5xx, 429, redirect, unreadable answer        -> may have been applied: NEVER re-sent, a person reconciles
 */
export type KeepupOpOutcome = { kind: "applied" } | { kind: "rejected"; reason: string } | { kind: "ambiguous"; reason: string };

export interface KeepupGateway {
  /** What this gateway really is. Readiness and tooling must look at this, never infer "live" from the fact that a call succeeded. */
  readonly kind?: "mock" | "http-sandbox" | "http-production";
  createSale(req: KeepupSaleRequest, opts: { signal?: AbortSignal }): Promise<KeepupCreateOutcome>;
  recordPayment(req: KeepupPaymentRequest, opts: { signal?: AbortSignal }): Promise<KeepupOpOutcome>;
  cancelSale(req: KeepupCancelRequest, opts: { signal?: AbortSignal }): Promise<KeepupOpOutcome>;
}

// ---------------------------------------------------------------------------------------------------------------------
export interface HttpKeepupGatewayConfig {
  baseUrl: string;
  apiKey: string;
  environment: "sandbox" | "production";
  /** Must be set to true as well as environment: "production" to talk to the real Keepup API host. */
  allowProduction?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

const PRODUCTION_HOSTS = new Set(["api.keepup.store"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Validates the base URL against SSRF / accidental-production rules. Throws on anything unsafe. */
export function assertSafeKeepupBaseUrl(raw: string, environment: "sandbox" | "production", allowProduction = false): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Keepup base URL is not a valid URL"); }
  if (u.username || u.password) throw new Error("Keepup base URL must not contain credentials");
  if (u.search || u.hash) throw new Error("Keepup base URL must not contain a query or fragment");
  const host = u.hostname.toLowerCase();
  const isProd = PRODUCTION_HOSTS.has(host);
  const isLocal = LOCAL_HOSTS.has(host);
  if (isProd && !(environment === "production" && allowProduction === true)) {
    throw new Error("Refusing to use the production Keepup API: it requires environment=production AND allowProduction=true (a cutover decision)");
  }
  if (!isProd && environment === "production") throw new Error("environment=production requires the production Keepup host");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal && environment === "sandbox")) {
    throw new Error("Keepup base URL must be https (plain http is allowed only for a local sandbox stub)");
  }
  if (!isProd && !isLocal && environment === "sandbox" && !/(^|\.)(sandbox|staging|test)[.-]/.test(host) && !host.endsWith(".invalid")) {
    // an arbitrary host is never contacted by accident: sandbox hosts must say so
    throw new Error("A sandbox Keepup host must be local or have a sandbox/staging/test host name");
  }
  return u;
}

export class HttpKeepupGateway implements KeepupGateway {
  get kind(): "http-sandbox" | "http-production" { return this.cfg.environment === "production" ? "http-production" : "http-sandbox"; }
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;
  constructor(private readonly cfg: HttpKeepupGatewayConfig) {
    this.base = assertSafeKeepupBaseUrl(cfg.baseUrl, cfg.environment, cfg.allowProduction);
    if (!cfg.apiKey || cfg.apiKey.length < 8) throw new Error("A Keepup API key is required");
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
    this.maxBytes = cfg.maxResponseBytes ?? 256 * 1024;
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  async createSale(req: KeepupSaleRequest, opts: { signal?: AbortSignal } = {}): Promise<KeepupCreateOutcome> {
    const items = req.items.map((it, i) => ({ item_id: i + 1, ...it }));
    const date = `${req.invoiceDate ?? new Date().toISOString().slice(0, 10)} 00:00`;
    const body: Record<string, unknown> = {
      items: JSON.stringify(items), payment_type: "bank_transfer", amount_received: "0", alert_customer: "yes",
      issue_date: date, due_date: date,
      notes: `Movezz ${req.reference} (${req.idempotencyKey})`,
    };
    if (req.customerName) body.customer_name = req.customerName;
    if (req.customerEmail?.includes("@")) body.customer_email = req.customerEmail;
    if (req.customerPhone) body.phone_number = req.customerPhone;

    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await this.doFetch(`${this.base.toString().replace(/\/$/, "")}/sales/add`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",                                  // never follow a redirect (SSRF; would also re-send the credential)
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      // timeout, abort, DNS, connection reset, redirect: the request may or may not have reached Keepup
      return { kind: "ambiguous", reason: `request failed after it may have been sent: ${(e as Error).name}` };
    }

    const text = await readLimited(res, this.maxBytes).catch(() => null);
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) {
      return { kind: "rejected", reason: `Keepup rejected the request (HTTP ${res.status})${safeMessage(text)}` };
    }
    if (!res.ok) return { kind: "ambiguous", reason: `Keepup answered HTTP ${res.status}; the sale may exist` };
    let data: Record<string, unknown> = {};
    try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { return { kind: "ambiguous", reason: "HTTP 2xx with an unparsable body; the sale may exist" }; }
    const d = ((data as { data?: Record<string, unknown> }).data ?? data) as Record<string, unknown>;
    const saleId = d.sale_id === undefined || d.sale_id === null ? "" : String(d.sale_id).trim();
    if (!saleId || saleId.length > 100) return { kind: "ambiguous", reason: "HTTP 2xx without a usable sale id; the sale may exist" };
    const link = typeof (d.share_link ?? d.link) === "string" ? String(d.share_link ?? d.link) : undefined;
    return { kind: "created", saleId, link: link && /^https:\/\//.test(link) ? link.slice(0, 500) : undefined,
             externalStatus: typeof d.status === "string" ? d.status.slice(0, 50) : undefined };
  }

  /** PUT /sales/balance/{sale}: same path and body as the live client (src/lib/keepup.ts recordKeepupPayment). Keepup documents no idempotency key. */
  async recordPayment(req: KeepupPaymentRequest, opts: { signal?: AbortSignal } = {}): Promise<KeepupOpOutcome> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.saleId)) return { kind: "rejected", reason: "the sale id is not usable in a request path" };
    if (!/^\d+(\.\d{1,2})?$/.test(req.amountGhs) || Number(req.amountGhs) <= 0) return { kind: "rejected", reason: "the payment amount is not a positive GHS amount" };
    return this.put(`/sales/balance/${req.saleId}`, { amount_paid: String(Number(req.amountGhs)), payment_type: "bank_transfer", date: `${req.paidOn} 00:00`, alert_customer: "yes" }, opts.signal);
  }

  /** PUT /sales/cancel/{sale}: same path and body as the live client (cancelKeepupSale). */
  async cancelSale(req: KeepupCancelRequest, opts: { signal?: AbortSignal } = {}): Promise<KeepupOpOutcome> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.saleId)) return { kind: "rejected", reason: "the sale id is not usable in a request path" };
    return this.put(`/sales/cancel/${req.saleId}`, { alert_customer: "no" }, opts.signal);
  }

  private async put(pathname: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<KeepupOpOutcome> {
    const signals = [AbortSignal.timeout(this.timeoutMs)]; if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await this.doFetch(`${this.base.toString().replace(/\/$/, "")}${pathname}`, {
        method: "PUT", headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
        redirect: "error", signal: AbortSignal.any(signals),
      });
    } catch (e) { return { kind: "ambiguous", reason: `request failed after it may have been sent: ${(e as Error).name}` }; }
    const text = await readLimited(res, this.maxBytes).catch(() => null);
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) return { kind: "rejected", reason: `Keepup rejected the request (HTTP ${res.status})${safeMessage(text)}` };
    if (!res.ok) return { kind: "ambiguous", reason: `Keepup answered HTTP ${res.status}; the operation may have been applied` };
    return { kind: "applied" };
  }
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error("response too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function safeMessage(text: string | null): string {
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    const m = String(j.error ?? j.message ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);
    return m ? `: ${m}` : "";
  } catch { return ""; }
}

// ---------------------------------------------------------------------------------------------------------------------
let mockSaleSeq = 0;                            // process-wide: two mock gateways never hand out the same sale id

/** Deterministic in-memory Keepup for tests: scripted outcomes per call, plus a record of every request it "received". */
export class MockKeepupGateway implements KeepupGateway {
  readonly kind = "mock" as const;
  readonly received: KeepupSaleRequest[] = [];
  private script: (KeepupCreateOutcome | Error | ((r: KeepupSaleRequest) => KeepupCreateOutcome | Promise<KeepupCreateOutcome>))[] = [];
  /** Queue outcomes consumed in order; when empty, every call creates a fresh sale (MOCK-1, MOCK-2, ...). */
  enqueue(...o: typeof this.script): this { this.script.push(...o); return this; }
  readonly receivedPayments: KeepupPaymentRequest[] = [];
  readonly receivedCancels: KeepupCancelRequest[] = [];
  private opScript: (KeepupOpOutcome | Error | ((r: KeepupPaymentRequest | KeepupCancelRequest) => KeepupOpOutcome | Promise<KeepupOpOutcome>))[] = [];
  /** Queue outcomes for payment/cancel calls, consumed in order; when empty every call is 'applied'. */
  enqueueOps(...o: typeof this.opScript): this { this.opScript.push(...o); return this; }
  private async op(r: KeepupPaymentRequest | KeepupCancelRequest): Promise<KeepupOpOutcome> {
    const next = this.opScript.shift(); if (next instanceof Error) throw next; if (typeof next === "function") return next(r); return next ?? { kind: "applied" };
  }
  async recordPayment(req: KeepupPaymentRequest): Promise<KeepupOpOutcome> { this.receivedPayments.push(req); return this.op(req); }
  async cancelSale(req: KeepupCancelRequest): Promise<KeepupOpOutcome> { this.receivedCancels.push(req); return this.op(req); }
  async createSale(req: KeepupSaleRequest): Promise<KeepupCreateOutcome> {
    this.received.push(req);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(req);
    if (next) return next;
    const n = ++mockSaleSeq;
    return { kind: "created", saleId: `MOCK-${n}`, link: `https://sandbox.keepup.invalid/s/MOCK-${n}` };
  }
}
