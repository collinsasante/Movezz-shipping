// Keepup.store invoicing integration
// Docs: https://docs.keepup.store/docs/api/sales

const BASE = "https://api.keepup.store/v2.0";

// Same Cloudflare context fallback used by firebase-admin.ts
function getCfEnv(): Record<string, string | undefined> {
  const ctx = (globalThis as Record<symbol, unknown>)[
    Symbol.for("__cloudflare-context__")
  ] as { env?: Record<string, string> } | undefined;
  return ctx?.env ?? {};
}

function getKey(): string {
  const key = process.env.KEEPUP_API_KEY ?? getCfEnv()["KEEPUP_API_KEY"] ?? "";
  if (!key) throw new Error("KEEPUP_API_KEY is not set");
  return key;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getKey()}`,
    "Content-Type": "application/json",
  };
}

// Format a date string to "YYYY-MM-DD HH:mm" for Keepup
function toKeepupDate(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  const YYYY = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(d.getUTCDate()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} 00:00`;
}

export interface KeepupLineItem {
  item_id: number;
  item_name: string;
  quantity: number;
  price: number;
  item_type?: string;
}

export interface CreateSaleParams {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  items: Omit<KeepupLineItem, "item_id">[];
  notes?: string;
  reference?: string;
  invoiceDate?: string; // YYYY-MM-DD
}

export interface KeepupSaleResult {
  saleId: string;
  link?: string;
}

// POST /v2.0/sales/add — create a new invoice/sale
export async function createKeepupSale(
  params: CreateSaleParams
): Promise<KeepupSaleResult> {
  // Add sequential item_id to each line item (required by Keepup)
  const itemsWithIds: KeepupLineItem[] = params.items.map((item, i) => ({
    item_id: i + 1,
    ...item,
  }));

  const issueDate = toKeepupDate(params.invoiceDate);
  // Due date: 30 days after issue date
  const dueDateObj = params.invoiceDate ? new Date(params.invoiceDate) : new Date();
  dueDateObj.setDate(dueDateObj.getDate() + 30);
  const dueDate = toKeepupDate(dueDateObj.toISOString());

  // Normalize phone to international format if possible
  let normalizedPhone: string | undefined;
  if (params.customerPhone) {
    const digits = params.customerPhone.replace(/\D/g, "");
    if (digits.startsWith("233") && digits.length >= 12) {
      normalizedPhone = `+${digits}`;
    } else if (digits.startsWith("0") && digits.length === 10) {
      normalizedPhone = `+233${digits.slice(1)}`;
    } else if (digits.length >= 10) {
      normalizedPhone = `+${digits}`;
    }
  }

  const body: Record<string, unknown> = {
    items: JSON.stringify(itemsWithIds),
    payment_type: "bank_transfer",
    amount_received: "0",
    alert_customer: "no",
    issue_date: issueDate,
    due_date: dueDate,
  };
  if (params.customerName) body.customer_name = params.customerName;
  if (params.customerEmail && params.customerEmail.includes("@")) body.customer_email = params.customerEmail;
  if (normalizedPhone) body.phone_number = normalizedPhone;

  const res = await fetch(`${BASE}/sales/add`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Keepup API error ${res.status}`
    );
  }

  const d = (data as { data?: { sale_id?: number | string; share_link?: string; link?: string }; sale_id?: number | string; share_link?: string; link?: string }).data ?? data;
  return {
    saleId: String(d.sale_id ?? ""),
    link: d.share_link ?? d.link ?? undefined,
  };
}

export interface KeepupSaleStatus {
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  shareLink?: string;
}

// GET /v2.0/sales/{sale_id} — fetch only the share link (non-throwing)
export async function fetchKeepupShareLink(saleId: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/sales/${saleId}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const d = (data as Record<string, unknown>).data ?? data;
    return (d as Record<string, unknown>).share_link as string ?? null;
  } catch {
    return null;
  }
}

// GET /v2.0/sales/{sale_id} — fetch sale details and payment status
export async function getKeepupSale(saleId: string): Promise<KeepupSaleStatus> {
  const res = await fetch(`${BASE}/sales/${saleId}`, {
    headers: authHeaders(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Keepup fetch error ${res.status}`
    );
  }

  // Response may be nested under data or at root
  const d = (data as Record<string, unknown>).data ?? data;
  const r = d as Record<string, unknown>;
  const totalAmount = parseFloat(String(r.total_amount ?? r.amount ?? r.grand_total ?? "")) || null;
  const rawAmountPaid = parseFloat(String(r.amount_paid ?? r.amount_received ?? r.paid_amount ?? r.paid ?? ""));
  const amountPaid = isNaN(rawAmountPaid) ? 0 : rawAmountPaid;
  const rawBalanceDue = parseFloat(String(r.balance_due ?? r.balance ?? r.amount_due ?? r.remaining ?? ""));
  const balanceDue = isNaN(rawBalanceDue) ? (totalAmount !== null ? totalAmount - amountPaid : 0) : rawBalanceDue;

  const shareLink = (d as Record<string, unknown>).share_link as string | undefined;

  // Guard: if we couldn't parse a total_amount, the response is unexpected — throw so
  // the caller doesn't falsely mark orders as Paid
  if (totalAmount === null) {
    throw new Error("Keepup response missing total_amount — skipping status update");
  }

  return { totalAmount, amountPaid, balanceDue, shareLink };
}

// PUT /v2.0/sales/balance/{sale_id} — record a payment
export async function recordKeepupPayment(
  saleId: string,
  amount: number
): Promise<void> {
  const res = await fetch(`${BASE}/sales/balance/${saleId}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      amount_paid: String(amount),
      payment_type: "bank_transfer",
      date: toKeepupDate(),
      alert_customer: "no",
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (data as { error?: string }).error ??
        `Keepup balance error ${res.status}`
    );
  }
}

export interface UpdateSaleParams {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  items?: Omit<KeepupLineItem, "item_id">[];
  invoiceDate?: string;
}

// PUT /v2.0/sales/edit/{sale_id} — edit an existing sale
export async function updateKeepupSale(
  saleId: string,
  params: UpdateSaleParams
): Promise<void> {
  const body: Record<string, unknown> = {};

  if (params.customerName) body.customer_name = params.customerName;
  if (params.customerEmail) body.customer_email = params.customerEmail;
  if (params.customerPhone) body.phone_number = params.customerPhone;
  if (params.invoiceDate) {
    body.issue_date = toKeepupDate(params.invoiceDate);
    const dueDateObj = new Date(params.invoiceDate);
    dueDateObj.setDate(dueDateObj.getDate() + 30);
    body.due_date = toKeepupDate(dueDateObj.toISOString());
  }
  if (params.items) {
    const itemsWithIds: KeepupLineItem[] = params.items.map((item, i) => ({
      item_id: i + 1,
      ...item,
    }));
    body.items = JSON.stringify(itemsWithIds);
  }

  const res = await fetch(`${BASE}/sales/edit/${saleId}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (data as { error?: string }).error ?? `Keepup edit error ${res.status}`
    );
  }
}

// PUT /v2.0/sales/cancel/{sale_id} — cancel a sale
export async function cancelKeepupSale(saleId: string): Promise<void> {
  const res = await fetch(`${BASE}/sales/cancel/${saleId}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ alert_customer: "no" }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (data as { error?: string }).error ??
        `Keepup cancel error ${res.status}`
    );
  }
}

// PUT /v2.0/sales/refund/{sale_id} — refund a sale
export async function refundKeepupSale(saleId: string): Promise<void> {
  const res = await fetch(`${BASE}/sales/refund/${saleId}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ alert_customer: "no" }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (data as { error?: string }).error ??
        `Keepup refund error ${res.status}`
    );
  }
}
