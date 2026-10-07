// ============================================================
// ACCOUNT LINKING — Firebase login ↔ Airtable Users/Customers
// ============================================================
// A Firebase login is tied to a Customer only by UID, and only the server
// writes that link (signup creates the Customer with its UID; admin creation
// and activation set it). Nothing here matches accounts by email: knowing a
// customer's email address must never be enough to claim their account.
// ============================================================
import { usersApi, customersApi } from "./airtable";
import type { AppUser } from "@/types";

// Collapses concurrent calls with the same key into one. The login page and
// AuthContext both call /api/auth/verify right after sign-in; without this
// both could create a Users row. Per-isolate only, which covers that case.
const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Returns the app user for a Firebase UID. When there is no Users row but a
 * Customer is already linked to this UID (a signup or admin creation that
 * stopped partway), the missing Users row is created or re-pointed.
 * Returns null when the UID belongs to no one in Pakkmaxx.
 */
export async function findOrRepairAppUser(
  uid: string,
  email: string | undefined
): Promise<AppUser | null> {
  return singleFlight(`app-user:${uid}`, async () => {
    const existing = await usersApi.getByFirebaseUid(uid);
    if (existing) return existing;

    const customer = await customersApi.getByFirebaseUid(uid);
    if (!customer) return null;

    // A Users row may exist for this customer without a UID (legacy rows) or
    // with a stale one. The Customer's FirebaseUID is server-written, so it wins.
    const byCustomer = await usersApi.getByCustomerId(customer.id);
    if (byCustomer) {
      console.warn(`[accounts] relinking Users ${byCustomer.id} to UID of customer ${customer.id}`);
      return usersApi.relinkFirebaseUid(byCustomer.id, uid, email ?? customer.email);
    }

    console.warn(`[accounts] creating missing Users row for customer ${customer.id}`);
    return usersApi.create(uid, email ?? customer.email, "customer", customer.id);
  });
}
