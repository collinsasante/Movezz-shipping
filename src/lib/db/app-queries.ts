// Read queries shared by the PostgreSQL route implementations. Ownership is applied in SQL: a customer actor is always restricted to
// their own customer id (derived from the verified actor, never from the request), staff/admin are unrestricted for operational data.
import type { Queryable } from "./client";
import type { ActorContext } from "./authz";
import { DomainError } from "./errors";
import { itemOut, orderOut } from "./mappers";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** NULL for staff/admin; the actor's own customer for a customer; fails closed for a customer without a link. */
export function ownerScope(a: ActorContext): string | null {
  if (a.role === "customer") {
    if (!a.customerId) throw new DomainError("NOT_AUTHORIZED", "Forbidden");
    return a.customerId;
  }
  return null;
}

const ITEM_SELECT = `SELECT i.*, c.name AS customer_name, c.shipping_mark AS customer_shipping_mark, co.container_ref, co.eta AS container_eta,
    inv.invoice_ref, ca.carton_ref, ca.length AS carton_length, ca.width AS carton_width, ca.height AS carton_height, ca.weight_kg AS carton_weight_kg,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'url', p.url, 'filename', COALESCE(p.public_id, ''), 'size', 0, 'type', 'image/jpeg') ORDER BY p.sort_order, p.created_at)
              FROM item_photos p WHERE p.item_id = i.id AND p.archived_at IS NULL), '[]'::jsonb) AS photos
  FROM items i JOIN customers c ON c.id = i.customer_id LEFT JOIN containers co ON co.id = i.container_id
  LEFT JOIN invoices inv ON inv.id = i.invoice_id LEFT JOIN cartons ca ON ca.id = i.carton_id`;

export async function selectItems(tx: Queryable, where: string, values: unknown[], tail = "ORDER BY i.created_at DESC, i.id") {
  const { rows } = await tx.query(`${ITEM_SELECT} WHERE i.archived_at IS NULL AND (${where}) ${tail}`, values);
  return rows.map(itemOut);
}

const ORDER_SELECT = `SELECT v.*, (SELECT u.email FROM users u WHERE u.id = v.created_by) AS created_by_email, c.name AS customer_name, c.phone AS customer_phone,
    COALESCE((SELECT array_agg(i.id ORDER BY i.item_ref) FROM items i WHERE i.invoice_id = v.id), '{}') AS item_ids
  FROM invoices v JOIN customers c ON c.id = v.customer_id`;
export async function selectOrders(tx: Queryable, where: string, values: unknown[], tail = "ORDER BY v.created_at DESC, v.id") {
  const { rows } = await tx.query(`${ORDER_SELECT} WHERE (${where}) ${tail}`, values);
  return rows.map(orderOut);
}
