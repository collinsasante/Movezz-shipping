// PostgreSQL rows -> the camelCase shapes the frontend already consumes (src/types). Pure functions, no I/O.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : v ? String(v) : "");
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : "");
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined || (v as unknown) === "" ? undefined : v);

export function customerOut(r: Row) {
  return {
    id: r.id, name: r.name, phone: r.phone ?? "", email: r.email ?? "", shippingAddress: r.shipping_address ?? "", shippingMark: r.shipping_mark,
    status: r.status, shippingType: opt(r.shipping_type), package: opt(r.package_tier), notes: opt(r.notes),
    preferredWarehouseId: opt(r.preferred_warehouse_id), createdAt: iso(r.created_at),
  };
}

export function appUserOut(r: Row) {
  return {
    id: r.id, firebaseUid: r.auth_uid, email: r.email, role: r.role, customerId: opt(r.customer_id), customerName: opt(r.customer_name),
    phone: opt(r.customer_phone), shippingMark: opt(r.shipping_mark), shippingAddress: opt(r.shipping_address), package: opt(r.package_tier),
    preferredWarehouseId: opt(r.preferred_warehouse_id), createdAt: iso(r.created_at), lastLogin: opt(r.last_login_at ? iso(r.last_login_at) : undefined),
  };
}
/** SELECT list + joins that appUserOut expects. */
export const APP_USER_SQL = `SELECT u.id, u.auth_uid, u.email, u.role, u.customer_id, u.created_at, u.last_login_at, u.is_active,
    c.name AS customer_name, c.phone AS customer_phone, c.shipping_mark, c.shipping_address, c.package_tier, c.preferred_warehouse_id, c.status AS customer_status
  FROM users u LEFT JOIN customers c ON c.id = u.customer_id`;

export function itemOut(r: Row) {
  const inCarton = !!r.carton_id;
  return {
    id: r.id, itemRef: r.item_ref, photos: (r.photos ?? []) as unknown[], weight: num(r.weight_kg), shippingType: opt(r.freight_type),
    length: num(r.length), width: num(r.width), height: num(r.height), dimensionUnit: r.dimension_unit ?? "cm", description: r.description ?? "",
    dateReceived: day(r.received_date), trackingNumber: opt(r.tracking_number), customerId: r.customer_id, customerName: opt(r.customer_name),
    customerShippingMark: opt(r.customer_shipping_mark), status: r.status, containerId: opt(r.container_id), containerName: opt(r.container_ref),
    containerEta: opt(r.container_eta ? day(r.container_eta) : undefined), orderId: opt(r.invoice_id), orderRef: opt(r.invoice_ref), isMissing: !!r.is_missing,
    quantity: num(r.quantity), estPrice: num(r.est_price_usd), estShippingPrice: num(r.est_price_usd), pkgEstShipping: num(r.tier_price_usd),
    pkgShippingRate: num(r.tier_rate_usd), specialShippingRate: num(r.special_rate_usd), isSpecialItem: r.billing_basis === "special",
    specialRateName: opt(r.special_rate_name), cartonNumber: inCarton ? opt(r.carton_ref) : undefined, cartonLength: inCarton ? num(r.carton_length) : undefined,
    cartonWidth: inCarton ? num(r.carton_width) : undefined, cartonHeight: inCarton ? num(r.carton_height) : undefined,
    cartonWeight: inCarton ? num(r.carton_weight_kg) : undefined, notes: opt(r.notes), createdAt: iso(r.created_at), createdBy: opt(r.created_by),
  };
}

export function containerOut(r: Row) {
  return {
    id: r.id, containerId: r.container_ref, name: opt(r.shipping_line), description: opt(r.description), status: r.status, itemIds: (r.item_ids ?? []) as string[],
    itemCount: r.item_count === undefined ? undefined : Number(r.item_count), eta: opt(r.eta ? day(r.eta) : undefined),
    arrivalDate: opt(r.arrival_date ? day(r.arrival_date) : undefined), trackingNumber: r.container_number ?? "", notes: opt(r.notes),
    createdAt: iso(r.created_at), createdBy: opt(r.created_by), totalCbm: num(r.total_cbm),
  };
}

export function orderOut(r: Row) {
  return {
    id: r.id, orderRef: r.invoice_ref, customerId: r.customer_id, customerName: opt(r.customer_name), customerPhone: opt(r.customer_phone),
    itemIds: (r.item_ids ?? []) as string[], invoiceAmount: num(r.subtotal_usd) ?? 0, discount: num(r.discount_usd) || undefined, /* absent (not 0) without a discount: the UI renders a bare `0` otherwise */ status: r.status,
    invoiceDate: day(r.invoice_date), notes: opt(r.notes), createdAt: iso(r.created_at), keepupSaleId: opt(r.keepup_sale_id), keepupLink: opt(r.keepup_link), keepupSyncState: opt(r.keepup_sync_state),
    createdBy: opt(r.created_by_email), amountPaid: num(r.amount_paid_ghs), balanceDue: num(r.balance_ghs),
    // the locked financial model, exposed explicitly (GHS payments, frozen FX); never recomputed from today's rate
    totalUsd: num(r.total_usd), totalGhs: num(r.total_ghs), fxRate: num(r.fx_rate), fxEstimated: !!r.fx_estimated, currency: "GHS", provenance: r.provenance,
    cancelledAt: opt(r.cancelled_at ? iso(r.cancelled_at) : undefined), cancelReason: opt(r.cancel_reason),
  };
}
