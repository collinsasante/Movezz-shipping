// Group F: dashboards, reports, activity log on PostgreSQL. Money follows the locked financial model: USD figures are the invoice's own
// (net of discount) totals, GHS figures are the amounts actually received / still owed; the two are NEVER added together and no figure
// is re-valued at today's exchange rate.
import type { NextRequest } from "next/server";
import { authorize, isAllowed } from "@/lib/db/authz";
import { DomainError } from "@/lib/db/errors";
import { isUuid, ownerScope, selectItems, selectOrders } from "@/lib/db/app-queries";
import { pgRoute, ok, throttle } from "@/lib/pg-api";

const n = (v: unknown) => Number(v ?? 0);
const MONTH = (col: string) => `to_char(${col}, 'YYYY-MM')`;
function months() { const now = new Date(); return Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }); }

export const adminDashboardGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin", "warehouse_staff"], async (c) => {
  const t = c.tx;
  const one = async (sql: string) => (await t.query(sql)).rows[0];
  const cust = await one("SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM customers WHERE archived_at IS NULL");
  const it = await one(`SELECT count(*) FILTER (WHERE status = 'Arrived at Transit Warehouse')::int AS warehouse, count(*) FILTER (WHERE status = 'Sorting')::int AS sorting,
      count(*) FILTER (WHERE is_missing)::int AS lost, count(*) FILTER (WHERE status = 'Ready for Pickup')::int AS ready, COALESCE(sum(cbm_total), 0) AS cbm FROM items WHERE archived_at IS NULL`);
  const transit = n((await one("SELECT count(*) AS n FROM containers WHERE status = 'Shipped to Ghana' AND archived_at IS NULL")).n);
  const byStatus: Record<string, number> = {};
  for (const r of (await t.query("SELECT status, count(*)::int AS n FROM items WHERE archived_at IS NULL GROUP BY status")).rows) byStatus[r.status] = r.n;
  const recentShipments = (await t.query(`SELECT i.id, i.item_ref, c.name AS customer_name, co.container_ref, i.status, i.tracking_number, i.received_date FROM items i JOIN customers c ON c.id = i.customer_id
      LEFT JOIN containers co ON co.id = i.container_id WHERE i.archived_at IS NULL ORDER BY i.received_date DESC NULLS LAST, i.created_at DESC LIMIT 5`)).rows
    .map((r) => ({ id: r.id, itemRef: r.item_ref, customerName: r.customer_name, containerName: r.container_ref ?? undefined, status: r.status, trackingNumber: r.tracking_number ?? undefined, dateReceived: r.received_date ? new Date(r.received_date).toISOString().slice(0, 10) : "" }));
  const base = { totalCustomers: cust.total, activeCustomers: cust.active, itemsInWarehouse: it.warehouse, containersInTransit: transit, itemsInSorting: it.sorting, lostItems: it.lost, readyForPickup: it.ready,
    totalCbm: n(it.cbm), itemsByStatus: byStatus, recentShipments };
  if (c.actor.role !== "super_admin") return ok({ ...base, totalRevenue: 0, pendingRevenue: 0, pendingOrders: [], recentOrders: [], ordersThisMonth: 0 });
  await authorize(t, "report.financial");
  const fin = await one(`SELECT COALESCE(sum(total_usd) FILTER (WHERE status = 'Paid'), 0) AS rev_usd, COALESCE(sum(total_usd) FILTER (WHERE status = 'Pending'), 0) AS pend_usd,
      COALESCE(sum(amount_paid_ghs), 0) AS received_ghs, COALESCE(sum(balance_ghs) FILTER (WHERE status IN ('Pending','Partial')), 0) AS owed_ghs,
      count(*) FILTER (WHERE date_trunc('month', invoice_date) = date_trunc('month', now()))::int AS this_month FROM invoices WHERE status <> 'Cancelled'`);
  const pendingOrders = await selectOrders(t, "v.status = 'Pending'", [], "ORDER BY v.created_at DESC, v.id LIMIT 100");   // newest 100: the screen does not use this list, the cap keeps the response bounded
  const recent = (await selectOrders(t, "v.status <> 'Cancelled'", [], "ORDER BY v.created_at DESC, v.id LIMIT 5")).map((o) => ({ id: o.id, orderRef: o.orderRef, customerName: o.customerName, invoiceAmount: o.invoiceAmount, invoiceDate: o.invoiceDate, status: o.status, itemCount: o.itemIds.length }));
  return ok({ ...base, totalRevenue: n(fin.rev_usd), pendingRevenue: n(fin.pend_usd), totalRevenueGhs: n(fin.received_ghs), outstandingBalanceGhs: n(fin.owed_ghs), pendingOrders, ordersThisMonth: fin.this_month, recentOrders: recent });
});

export const customerDashboardGet = (request: NextRequest) => pgRoute(request, undefined, ["customer", "super_admin"], async (c) => {
  const scope = ownerScope(c.actor);
  const wanted = scope ?? new URL(c.request.url).searchParams.get("customerId");
  if (!wanted) throw new DomainError("INVALID_INPUT", "Customer ID is required");
  if (!isUuid(wanted)) throw new DomainError("NOT_FOUND", "Customer not found");
  const items = await selectItems(c.tx, "i.customer_id = $1", [wanted]);
  const orders = isAllowed(c.actor, "invoice.read.any") || isAllowed(c.actor, "invoice.read.own") ? await selectOrders(c.tx, "v.customer_id = $1 AND v.status <> 'Cancelled'", [wanted]) : [];
  const itemsByStatus: Record<string, number> = {};
  for (const i of items) itemsByStatus[i.status] = (itemsByStatus[i.status] ?? 0) + 1;
  const totalCbm = (await c.tx.query("SELECT COALESCE(sum(cbm_total), 0) AS c FROM items WHERE customer_id = $1 AND archived_at IS NULL", [wanted])).rows[0].c;
  return ok({ totalItems: items.length, itemsByStatus, totalOrders: orders.length, pendingPayment: orders.filter((o) => o.status === "Pending").reduce((s, o) => s + (o.totalUsd ?? 0), 0),
    pendingPaymentGhs: orders.filter((o) => o.status === "Pending" || o.status === "Partial").reduce((s, o) => s + (o.balanceDue ?? 0), 0), totalCbm: n(totalCbm), recentItems: items, recentOrders: orders });
});

export const reportsGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  throttle(c.actor.userId, "reports", 30);
  await authorize(c.tx, "report.financial");
  const sp = new URL(c.request.url).searchParams; const t = c.tx;
  const from = sp.get("from") && !isNaN(Date.parse(sp.get("from")!)) ? sp.get("from")!.slice(0, 10) : null;
  const to = sp.get("to") && !isNaN(Date.parse(sp.get("to")!)) ? sp.get("to")!.slice(0, 10) : null;
  const W = "v.status <> 'Cancelled' AND ($1::date IS NULL OR v.invoice_date >= $1) AND ($2::date IS NULL OR v.invoice_date <= $2)";
  const v = [from, to];
  const tot = (await t.query(`SELECT count(*)::int AS orders, count(*) FILTER (WHERE v.status = 'Paid')::int AS paid, COALESCE(sum(v.total_usd) FILTER (WHERE v.status = 'Paid'), 0) AS rev,
      COALESCE(sum(v.total_usd) FILTER (WHERE v.status = 'Pending'), 0) AS pend, COALESCE(sum(v.amount_paid_ghs), 0) AS received_ghs, COALESCE(sum(v.balance_ghs) FILTER (WHERE v.status IN ('Pending','Partial')), 0) AS owed_ghs,
      COALESCE(sum(v.total_usd) FILTER (WHERE v.status = 'Paid' AND date_trunc('month', v.invoice_date) = date_trunc('month', now())), 0) AS month_rev,
      COALESCE(sum(v.total_usd) FILTER (WHERE v.status = 'Paid' AND date_trunc('year', v.invoice_date) = date_trunc('year', now())), 0) AS year_rev FROM invoices v WHERE ${W}`, v)).rows[0];
  const revByMonth = new Map((await t.query(`SELECT ${MONTH("v.invoice_date")} AS m, sum(v.total_usd) AS r FROM invoices v WHERE v.status = 'Paid' GROUP BY 1`)).rows.map((r) => [r.m, n(r.r)]));
  const shipByMonth = new Map((await t.query(`SELECT ${MONTH("received_date")} AS m, count(*)::int AS n FROM items WHERE archived_at IS NULL AND received_date IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.m, r.n]));
  const top = (await t.query(`SELECT c.id, c.name, sum(v.total_usd) AS revenue, count(*)::int AS orders FROM invoices v JOIN customers c ON c.id = v.customer_id WHERE ${W} AND v.status = 'Paid' GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 10`, v)).rows
    .map((r) => ({ id: r.id, name: r.name, revenue: n(r.revenue), orders: r.orders }));
  const analytics = (await t.query(`SELECT c.id, c.name, count(v.id)::int AS total_orders, COALESCE(sum(v.total_usd) FILTER (WHERE v.status = 'Paid'), 0) AS rev,
      COALESCE(sum(v.total_usd) FILTER (WHERE v.status IN ('Pending','Partial')), 0) AS out_usd, COALESCE(sum(v.balance_ghs) FILTER (WHERE v.status IN ('Pending','Partial')), 0) AS out_ghs
      FROM customers c LEFT JOIN invoices v ON v.customer_id = c.id AND ${W} WHERE c.archived_at IS NULL GROUP BY c.id, c.name ORDER BY rev DESC, c.name`, v)).rows
    .map((r) => ({ id: r.id, name: r.name, totalOrders: r.total_orders, totalRevenue: n(r.rev), outstandingBalance: n(r.out_usd), outstandingBalanceGhs: n(r.out_ghs) }));
  const outstanding = (await t.query(`SELECT v.id, v.invoice_ref, c.name, v.subtotal_usd, v.total_usd, v.balance_ghs, v.invoice_date, v.status FROM invoices v JOIN customers c ON c.id = v.customer_id WHERE ${W} AND v.status IN ('Pending','Partial') ORDER BY v.invoice_date, v.id`, v)).rows
    .map((r) => ({ id: r.id, orderRef: r.invoice_ref, customerName: r.name, invoiceAmount: n(r.subtotal_usd), totalUsd: n(r.total_usd), balanceDueGhs: n(r.balance_ghs), invoiceDate: new Date(r.invoice_date).toISOString().slice(0, 10), status: r.status }));
  const shipments = Number((await t.query("SELECT count(*) AS n FROM items WHERE archived_at IS NULL")).rows[0].n);
  return ok({ totalRevenue: n(tot.rev), pendingRevenue: n(tot.pend), totalRevenueGhs: n(tot.received_ghs), outstandingBalanceGhs: n(tot.owed_ghs), totalOrders: tot.orders, paidOrders: tot.paid,
    monthlyRevenue: months().map((m) => ({ month: m, revenue: revByMonth.get(m) ?? 0 })), topCustomers: top, revenueThisMonth: n(tot.month_rev), revenueThisYear: n(tot.year_rev),
    avgOrderValue: tot.paid > 0 ? n(tot.rev) / tot.paid : 0, totalShipments: shipments, monthlyShipments: months().map((m) => ({ month: m, count: shipByMonth.get(m) ?? 0 })), customerAnalytics: analytics, outstandingPayments: outstanding });
});

export const activityLogsGet = (request: NextRequest) => pgRoute(request, undefined, ["super_admin"], async (c) => {
  const lp = parseInt(new URL(c.request.url).searchParams.get("limit") ?? "100"); const limit = isNaN(lp) || lp < 1 ? 100 : Math.min(lp, 1000);
  const { rows } = await c.tx.query(`SELECT a.id, a.action, a.entity_type, a.entity_id, a.after_data, a.created_at, a.ip_address, u.email, u.role FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT $1`, [limit]);
  return ok(rows.map((r) => ({ id: String(r.id), action: r.action, userEmail: r.email ?? "system", userRole: r.role ?? "warehouse_staff", details: r.after_data ? JSON.stringify(r.after_data) : "",
    entityType: r.entity_type ?? undefined, entityId: r.entity_id ?? undefined, timestamp: r.created_at.toISOString(), ipAddress: r.ip_address ?? undefined })));
});
