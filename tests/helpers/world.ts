/// <reference types="vite/types/importMeta.d.ts" />
// Test "world" builder: a fresh application instance per test, backed by the
// in-memory Airtable and mocked integrations. See tests/README.md.
import { vi } from "vitest";
import { NextRequest } from "next/server";
import { getDb, type Fields } from "./fakeAirtable";
import { state, resetState } from "./state";

const routeLoaders = import.meta.glob("/src/app/api/**/route.ts") as Record<string, () => Promise<Record<string, unknown>>>;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Role = "super_admin" | "warehouse_staff" | "customer";

export interface CallOptions {
  /** Firebase ID token previously issued by world.asUser() */
  token?: string;
  /** Send the token as the auth-token cookie instead of a Bearer header */
  viaCookie?: boolean;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  json: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

export const ROUTES = Object.keys(routeLoaders)
  .map((k) => k.replace("/src/app/api/", "").replace("/route.ts", ""))
  .sort();

let userCounter = 0;

/** Builds a brand-new application instance (fresh module caches, empty database). */
export async function freshWorld() {
  vi.resetModules();
  resetState();
  const db = getDb();
  db.reset();
  userCounter = 0;
  // Deterministic clock; intervals created by module-level cleanup timers never fire.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-03-15T10:00:00.000Z"));

  const airtable = await import("@/lib/airtable");
  const keepup = await import("@/lib/keepup");
  const email = await import("@/lib/email");
  const firebase = await import("@/lib/firebase-admin");

  // ---------------------------------------------------------------- seeding
  const seed = {
    customer(id: string, fields: Fields = {}) {
      db.insert(
        "Customers",
        {
          Name: "Ada Mensah",
          Phone: "0244001234",
          Email: `${id.toLowerCase()}@example.invalid`,
          ShippingMark: "MOVEZZ-AM1234",
          ShippingAddress: "MOVEZZ-AM1234, A-Z Bulk Warehouse, Amrahia, Adenta-Dodowa Road",
          Status: "active",
          CustomerPackage: "basic",
          ...fields,
        },
        id
      );
      return id;
    },
    item(id: string, customerId: string, fields: Fields = {}) {
      db.insert(
        "Items",
        {
          ItemRef: `ITM-${id}`,
          Customer: [customerId],
          Status: "Arrived at Transit Warehouse",
          DateReceived: "2026-03-01",
          Description: `Box ${id}`,
          DimensionUnit: "cm",
          FreightType: "sea",
          ...fields,
        },
        id
      );
      return id;
    },
    container(id: string, fields: Fields = {}) {
      db.insert("Containers", { ContainerID: `PMX-CON-2026-${id}`, Status: "Loading", ...fields }, id);
      return id;
    },
    order(id: string, customerId: string, fields: Fields = {}) {
      db.insert(
        "Orders",
        { OrderRef: `ORD-${id}`, Customer: [customerId], InvoiceAmount: 100, Status: "Pending", InvoiceDate: "2026-03-10", ...fields },
        id
      );
      return id;
    },
    settings(usdToGhs: number, shippingRatePerCbm = 0) {
      db.insert("Settings", { UsdToGhs: usdToGhs, ShippingRatePerCbm: shippingRatePerCbm });
    },
    packageRate(tier: string, sea: number, air: number) {
      db.insert("PackageRates", { Tier: tier, Sea: sea, Air: air });
    },
    specialRate(id: string, name: string, sea: number, air: number) {
      db.insert("SpecialRates", { Name: name, Sea: sea, Air: air }, id);
      return id;
    },
  };

  // ------------------------------------------------------------------- auth
  /**
   * Creates a Users row (and, for role=customer, links it to `customerId`) and
   * returns a Firebase ID token the mocked verifyIdToken() will accept.
   */
  function asUser(role: Role, opts: { customerId?: string; email?: string; withUsersRow?: boolean } = {}): string {
    userCounter++;
    const uid = `uid-${role}-${userCounter}`;
    const email = opts.email ?? `${role}-${userCounter}@example.invalid`;
    const token = `token-${uid}`;
    state().tokens.set(token, { uid, email });
    if (opts.withUsersRow !== false) {
      db.insert("Users", {
        FirebaseUID: uid,
        Email: email,
        Role: role,
        ...(opts.customerId ? { CustomerRecord: [opts.customerId] } : {}),
      });
    }
    return token;
  }

  // ------------------------------------------------------------------- HTTP
  async function call(routePath: string, method: HttpMethod, opts: CallOptions = {}): Promise<CallResult> {
    const loader = routeLoaders[`/src/app/api/${routePath}/route.ts`];
    if (!loader) throw new Error(`No such route: /api/${routePath}`);
    const mod = await loader();
    const handler = mod[method] as Handler | undefined;
    if (!handler) throw new Error(`Route /api/${routePath} has no ${method} handler`);

    const url = new URL(`http://localhost/api/${routePath}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) {
      if (opts.viaCookie) headers["cookie"] = `auth-token=${opts.token}`;
      else headers["authorization"] = `Bearer ${opts.token}`;
    }
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (opts.body !== undefined && method !== "GET") init.body = JSON.stringify(opts.body);
    const request = new NextRequest(url, init);
    const response = await handler(request, { params: Promise.resolve(opts.params ?? {}) });
    let json: CallResult["json"];
    try {
      json = await response.clone().json();
    } catch {
      json = undefined;
    }
    return { status: response.status, json, headers: response.headers };
  }

  return { db, seed, asUser, call, airtable, keepup, email, firebase };
}

export type World = Awaited<ReturnType<typeof freshWorld>>;

/** A standard population: two customers, one admin, one staff member, one user per customer. */
export async function standardWorld() {
  const w = await freshWorld();
  w.seed.customer("recCustA", { Name: "Ada Mensah", Phone: "0244001111", ShippingMark: "MOVEZZ-AM1111" });
  w.seed.customer("recCustB", { Name: "Kofi Boateng", Phone: "0244002222", ShippingMark: "MOVEZZ-KB2222" });
  const admin = w.asUser("super_admin");
  const staff = w.asUser("warehouse_staff");
  const custA = w.asUser("customer", { customerId: "recCustA" });
  const custB = w.asUser("customer", { customerId: "recCustB" });
  return { w, admin, staff, custA, custB };
}

/** Every (route, method) pair exported by a route handler under src/app/api. */
export async function listRouteMethods(): Promise<{ route: string; method: HttpMethod }[]> {
  const out: { route: string; method: HttpMethod }[] = [];
  for (const [key, load] of Object.entries(routeLoaders)) {
    const mod = await load();
    const route = key.replace("/src/app/api/", "").replace("/route.ts", "");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as HttpMethod[]) {
      if (typeof mod[method] === "function") out.push({ route, method });
    }
  }
  return out.sort((a, b) => (a.route + a.method).localeCompare(b.route + b.method));
}
