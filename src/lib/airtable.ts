import Airtable, { FieldSet, Record as AirtableRecord } from "airtable";
import type {
  Customer,
  Item,
  ItemPhoto,
  Order,
  Container,
  StatusHistory,
  ActivityLog,
  AppUser,
  CreateCustomerInput,
  CreateItemInput,
  CreateOrderInput,
  CreateContainerInput,
  UpdateCustomerInput,
  UpdateItemInput,
  UpdateOrderInput,
  UpdateContainerInput,
  ItemStatus,
  ContainerStatus,
  OrderStatus,
  UserRole,
  ItemFilterParams,
  CustomerFilterParams,
  ContainerFilterParams,
  OrderFilterParams,
  Supplier,
  CreateSupplierInput,
  UpdateSupplierInput,
  Warehouse,
  CreateWarehouseInput,
} from "@/types";
import {
  generateShippingMark,
  generateShippingAddress,
  generateContainerId,
  generateOrderRef,
  generateItemRef,
  generateSupplierId,
  toISOString,
  buildWhatsAppMessage,
} from "./utils";

// ============================================================
// BUSINESS LOGIC ERROR — safe to expose message to client
// ============================================================
export class BusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessError";
  }
}

// Escape single quotes in Airtable formula strings to prevent injection
function escapeFormula(str: string): string {
  return str.replace(/'/g, "''");
}

// ============================================================
// AIRTABLE CLIENT INITIALIZATION
// ============================================================
const apiKey = process.env.AIRTABLE_API_KEY!;
const baseId = process.env.AIRTABLE_BASE_ID!;

let _base: ReturnType<Airtable["base"]> | null = null;

function getBase() {
  if (!_base) {
    if (!apiKey || !baseId) {
      throw new Error(
        "AIRTABLE_API_KEY and AIRTABLE_BASE_ID must be set in environment"
      );
    }
    Airtable.configure({ apiKey, requestTimeout: 25000 });
    _base = new Airtable().base(baseId);
  }
  return _base;
}

// ============================================================
// TABLE NAMES - match exactly what you create in Airtable
// ============================================================
export const TABLES = {
  CUSTOMERS: "Customers",
  ITEMS: "Items",
  ORDERS: "Orders",
  CONTAINERS: "Containers",
  STATUS_HISTORY: "StatusHistory",
  ACTIVITY_LOGS: "ActivityLogs",
  USERS: "Users",
  SUPPLIERS: "Suppliers",
  WAREHOUSES: "Warehouses",
  SPECIAL_RATES: "SpecialRates",
  PACKAGE_RATES: "PackageRates",
  SETTINGS: "Settings",
} as const;

// ============================================================
// AIRTABLE RETRY — handles 429 rate-limit responses
// Airtable allows 5 req/s per base. On 429, back off and retry.
// ============================================================
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      const isRateLimit =
        (err instanceof Error && err.message.includes("429")) ||
        (typeof err === "object" && err !== null && "statusCode" in err && (err as { statusCode: number }).statusCode === 429);

      if (isRateLimit && attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

// ============================================================
// GENERIC HELPERS
// ============================================================
async function getAllRecords(
  tableName: string,
  formula?: string,
  sort?: { field: string; direction: "asc" | "desc" }[]
): Promise<AirtableRecord<FieldSet>[]> {
  return withRetry(async () => {
    const base = getBase();
    const records: AirtableRecord<FieldSet>[] = [];

    const options: Parameters<ReturnType<typeof base>["select"]>[0] = {
      pageSize: 100,
    };
    if (formula) options.filterByFormula = formula;
    if (sort) options.sort = sort;

    await base(tableName)
      .select(options)
      .eachPage((pageRecords, fetchNextPage) => {
        records.push(...pageRecords);
        fetchNextPage();
      });

    return records;
  });
}

async function getRecord(
  tableName: string,
  id: string
): Promise<AirtableRecord<FieldSet>> {
  return withRetry(() => {
    const base = getBase();
    return base(tableName).find(id);
  });
}

async function createRecord(
  tableName: string,
  fields: FieldSet
): Promise<AirtableRecord<FieldSet>> {
  return withRetry(() => {
    const base = getBase();
    return base(tableName).create(fields);
  });
}

async function updateRecord(
  tableName: string,
  id: string,
  fields: FieldSet
): Promise<AirtableRecord<FieldSet>> {
  return withRetry(() => {
    const base = getBase();
    return base(tableName).update(id, fields);
  });
}

async function deleteRecord(tableName: string, id: string): Promise<void> {
  await withRetry(async () => {
    const base = getBase();
    await base(tableName).destroy(id);
  });
}

async function countRecords(
  tableName: string,
  formula?: string
): Promise<number> {
  const records = await getAllRecords(tableName, formula);
  return records.length;
}

// ============================================================
// RECORD MAPPERS - Airtable field → App type
// ============================================================
function mapCustomer(record: AirtableRecord<FieldSet>): Customer {
  const f = record.fields;
  return {
    id: record.id,
    name: (f["Name"] as string) ?? "",
    phone: (f["Phone"] as string) ?? "",
    email: (f["Email"] as string) ?? "",
    shippingAddress: (f["ShippingAddress"] as string) ?? "",
    shippingMark: (f["ShippingMark"] as string) ?? "",
    firebaseUid: (f["FirebaseUID"] as string) ?? undefined,
    status: ((f["Status"] as string) ?? "active") as Customer["status"],
    shippingType: ((f["ShippingType"] as string) ?? undefined) as Customer["shippingType"],
    package: (({ standard: "basic", discounted: "business", premium: "enterprise" } as Record<string, string>)[(f["CustomerPackage"] as string)] ?? (f["CustomerPackage"] as string) ?? undefined) as Customer["package"],
    exchangeRate: (f["ExchangeRate"] as number) ?? undefined,
    notes: (f["Notes"] as string) ?? undefined,
    preferredWarehouseId: (f["PreferredWarehouse"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? (record as any)._rawJson?.createdTime ?? "",
  };
}

function mapItem(record: AirtableRecord<FieldSet>): Item {
  const f = record.fields;
  const photos = (f["Photos"] as ItemPhoto[]) ?? [];
  return {
    id: record.id,
    itemRef: (f["ItemRef"] as string) ?? record.id,
    photos,
    weight: (f["Weight"] as number) || undefined,
    shippingType: ((f["FreightType"] as string) || undefined) as "air" | "sea" | undefined,
    length: (f["Length"] as number) ?? undefined,
    width: (f["Width"] as number) ?? undefined,
    height: (f["Height"] as number) ?? undefined,
    dimensionUnit: ((f["DimensionUnit"] as string) ?? "cm") as "cm" | "inches",
    description: (f["Description"] as string) ?? "",
    dateReceived: (f["DateReceived"] as string) || toISOString(),
    trackingNumber: (f["TrackingNumber"] as string) ?? undefined,
    customerId: ((f["Customer"] as string[]) ?? [])[0] ?? "",
    customerName: (Array.isArray(f["CustomerName"]) ? (f["CustomerName"] as string[])[0] : (f["CustomerName"] as string)) ?? undefined,
    customerShippingMark: (Array.isArray(f["CustomerShippingMark"]) ? (f["CustomerShippingMark"] as string[])[0] : (f["CustomerShippingMark"] as string)) ?? undefined,
    status: ((f["Status"] as string) ??
      "Arrived at Transit Warehouse") as ItemStatus,
    containerId: ((f["Container"] as string[]) ?? [])[0] ?? undefined,
    containerName: (f["ContainerName"] as string) ?? undefined,
    orderId: ((f["Order"] as string[]) ?? [])[0] ?? undefined,
    orderRef: (f["OrderRef"] as string) ?? undefined,
    isMissing: (f["IsMissing"] as boolean) ?? false,
    quantity: (f["Quantity"] as number) ?? undefined,
    estPrice: (f["EstPrice"] as number) ?? undefined,
    estShippingPrice: (f["EstShippingPrice"] as number) ?? undefined,
    pkgEstShipping: (f["PkgEstShipping"] as number) ?? undefined,
    pkgShippingRate: (f["PkgShippingRate"] as number) ?? undefined,
    specialShippingRate: (f["SpecialShippingRate"] as number) ?? undefined,
    isSpecialItem: (f["IsSpecialItem"] as boolean) ?? undefined,
    specialRateName: (f["specialRateName"] as string) ?? undefined,
    notes: (f["Notes"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
    createdBy: (f["CreatedBy"] as string) ?? undefined,
  };
}

function mapOrder(record: AirtableRecord<FieldSet>): Order {
  const f = record.fields;
  return {
    id: record.id,
    orderRef: (f["OrderRef"] as string) ?? record.id,
    customerId: ((f["Customer"] as string[]) ?? [])[0] ?? "",
    customerName: (f["CustomerName"] as string) ?? undefined,
    itemIds: (f["Items"] as string[]) ?? [],
    invoiceAmount: (f["InvoiceAmount"] as number) ?? 0,
    status: ((f["Status"] as string) ?? "Pending") as OrderStatus,
    invoiceDate: (f["InvoiceDate"] as string) ?? toISOString(),
    notes: (f["Notes"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
    keepupSaleId: (f["KeepupSaleId"] as string) ?? undefined,
    keepupLink: (f["KeepupLink"] as string) ?? undefined,
    amountPaid: (f["AmountPaid"] as number) ?? undefined,
    balanceDue: (f["BalanceDue"] as number) ?? undefined,
  };
}

function mapContainer(record: AirtableRecord<FieldSet>): Container {
  const f = record.fields;
  return {
    id: record.id,
    containerId: (f["ContainerID"] as string) ?? record.id,
    name: (f["Name"] as string) ?? undefined,
    description: (f["Description"] as string) ?? undefined,
    status: ((f["Status"] as string) ?? "Loading") as ContainerStatus,
    itemIds: (f["Items"] as string[]) ?? [],
    itemCount: ((f["Items"] as string[]) ?? []).length,
    eta: (f["DepartureDate"] as string) ?? undefined,
    arrivalDate: (f["ArrivalDate"] as string) ?? undefined,
    trackingNumber: (f["TrackingNumber"] as string) ?? "",
    notes: (f["Notes"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
    createdBy: (f["CreatedBy"] as string) ?? undefined,
  };
}

function mapStatusHistory(record: AirtableRecord<FieldSet>): StatusHistory {
  const f = record.fields;
  return {
    id: record.id,
    recordType: (f["RecordType"] as "Item" | "Container" | "Order") ?? "Item",
    recordId: (f["RecordID"] as string) ?? "",
    recordRef: (f["RecordRef"] as string) ?? "",
    previousStatus: (f["PreviousStatus"] as string) ?? "",
    newStatus: (f["NewStatus"] as string) ?? "",
    changedBy: (f["ChangedBy"] as string) ?? "",
    changedByRole: (f["ChangedByRole"] as UserRole) ?? "warehouse_staff",
    changedAt: (f["ChangedAt"] as string) ?? toISOString(),
    notes: (f["Notes"] as string) ?? undefined,
  };
}

function mapActivityLog(record: AirtableRecord<FieldSet>): ActivityLog {
  const f = record.fields;
  return {
    id: record.id,
    action: (f["Action"] as string) ?? "",
    userEmail: (f["UserEmail"] as string) ?? "",
    userRole: (f["UserRole"] as UserRole) ?? "warehouse_staff",
    details: (f["Details"] as string) ?? "",
    entityType: (f["EntityType"] as string) ?? undefined,
    entityId: (f["EntityID"] as string) ?? undefined,
    timestamp: (f["Timestamp"] as string) ?? toISOString(),
    ipAddress: (f["IPAddress"] as string) ?? undefined,
  };
}

function mapUser(record: AirtableRecord<FieldSet>): AppUser {
  const f = record.fields;
  const rawName = f["CustomerName"];
  return {
    id: record.id,
    firebaseUid: (f["FirebaseUID"] as string) ?? "",
    email: (f["Email"] as string) ?? "",
    role: (f["Role"] as UserRole) ?? "customer",
    customerId: ((f["CustomerRecord"] as string[]) ?? [])[0] ?? undefined,
    customerName: (Array.isArray(rawName) ? rawName[0] : rawName) as string | undefined,
    createdAt: (f["CreatedAt"] as string) ?? (record as any)._rawJson?.createdTime ?? "",
    lastLogin: (f["LastLogin"] as string) ?? undefined,
  };
}

// ============================================================
// CUSTOMERS API
// ============================================================
// Short-lived cache for unfiltered customersApi.list() — used for customer name resolution
// on every items/orders fetch. 60s TTL dramatically cuts redundant Airtable full-table scans.
let _customerListCache: { data: Customer[]; expiresAt: number } | null = null;
const CUSTOMER_LIST_CACHE_TTL = 60_000;
function invalidateCustomerCache() { _customerListCache = null; }

export const customersApi = {
  async list(params: CustomerFilterParams = {}): Promise<Customer[]> {
    const isUnfiltered = !params.status && !params.search;
    if (isUnfiltered && _customerListCache && _customerListCache.expiresAt > Date.now()) {
      return _customerListCache.data;
    }

    const formulas: string[] = [];
    if (params.status) formulas.push(`{Status} = '${params.status}'`);
    if (params.search) {
      const s = escapeFormula(params.search.toLowerCase());
      formulas.push(
        `OR(SEARCH('${s}', LOWER({Name})), SEARCH('${s}', LOWER({Email})), SEARCH('${s}', LOWER({ShippingMark})))`
      );
    }
    const formula =
      formulas.length > 1
        ? `AND(${formulas.join(",")})`
        : formulas[0] ?? "";

    const records = await getAllRecords(TABLES.CUSTOMERS, formula || undefined);
    const customers = records.map(mapCustomer).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    if (isUnfiltered) {
      _customerListCache = { data: customers, expiresAt: Date.now() + CUSTOMER_LIST_CACHE_TTL };
    }
    return customers;
  },

  async getById(id: string): Promise<Customer> {
    const record = await getRecord(TABLES.CUSTOMERS, id);
    return mapCustomer(record);
  },

  async getByFirebaseUid(uid: string): Promise<Customer | null> {
    const records = await getAllRecords(
      TABLES.CUSTOMERS,
      `{FirebaseUID} = '${escapeFormula(uid)}'`
    );
    if (records.length === 0) return null;
    return mapCustomer(records[0]);
  },

  async getByPhone(phone: string): Promise<Customer | null> {
    const records = await getAllRecords(
      TABLES.CUSTOMERS,
      `{Phone} = '${escapeFormula(phone)}'`
    );
    if (records.length === 0) return null;
    return mapCustomer(records[0]);
  },

  async getByEmail(email: string): Promise<Customer | null> {
    const records = await getAllRecords(
      TABLES.CUSTOMERS,
      `{Email} = '${escapeFormula(email)}'`
    );
    if (records.length === 0) return null;
    return mapCustomer(records[0]);
  },

  async create(
    input: CreateCustomerInput,
    createdByEmail: string
  ): Promise<Customer> {
    const shippingMark = generateShippingMark(input.name, input.phone);
    const shippingAddress = input.shippingAddress || generateShippingAddress(shippingMark);

    // Get current count for potential future use
    const record = await createRecord(TABLES.CUSTOMERS, {
      Name: input.name,
      Phone: input.phone,
      Email: input.email,
      ShippingMark: shippingMark,
      ShippingAddress: shippingAddress,
      Status: "active",
      Notes: input.notes ?? "",
      // CreatedAt is a "Created time" field — Airtable fills it automatically
      CreatedBy: createdByEmail,
    });

    invalidateCustomerCache();
    return mapCustomer(record);
  },

  async update(
    id: string,
    input: UpdateCustomerInput,
    updatedByEmail: string
  ): Promise<Customer> {
    const fields: FieldSet = {};
    if (input.name !== undefined) {
      fields["Name"] = input.name;
      // Regenerate shipping mark if name changed
      const existing = await getRecord(TABLES.CUSTOMERS, id);
      const phone = (existing.fields["Phone"] as string) ?? "";
      const newMark = generateShippingMark(input.name, phone);
      fields["ShippingMark"] = newMark;
      fields["ShippingAddress"] = generateShippingAddress(newMark);
    }
    if (input.phone !== undefined) {
      fields["Phone"] = input.phone;
      const existing = await getRecord(TABLES.CUSTOMERS, id);
      const name = (existing.fields["Name"] as string) ?? "";
      const newMark = generateShippingMark(name, input.phone);
      fields["ShippingMark"] = newMark;
      fields["ShippingAddress"] = generateShippingAddress(newMark);
    }
    if (input.email !== undefined) fields["Email"] = input.email;
    if (input.notes !== undefined) fields["Notes"] = input.notes;
    if (input.status !== undefined) fields["Status"] = input.status;
    if (input.shippingType !== undefined) fields["ShippingType"] = input.shippingType;
    if (input.package !== undefined) fields["CustomerPackage"] = input.package;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (input.exchangeRate !== undefined) fields["ExchangeRate"] = input.exchangeRate as any;
    if (input.shippingAddress !== undefined) fields["ShippingAddress"] = input.shippingAddress;

    const record = await updateRecord(TABLES.CUSTOMERS, id, fields);
    invalidateCustomerCache();
    return mapCustomer(record);
  },

  async linkFirebaseUid(id: string, uid: string): Promise<void> {
    await updateRecord(TABLES.CUSTOMERS, id, { FirebaseUID: uid });
  },

  async setPreferredWarehouse(id: string, warehouseId: string): Promise<void> {
    await updateRecord(TABLES.CUSTOMERS, id, { PreferredWarehouse: warehouseId });
    invalidateCustomerCache();
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(TABLES.CUSTOMERS, id);
    invalidateCustomerCache();
  },
};

// ============================================================
// ITEMS API
// ============================================================
export const itemsApi = {
  async list(params: ItemFilterParams = {}): Promise<Item[]> {
    // Only use Airtable formula for fields that are NOT linked records.
    // Linked record fields (Customer, Container, Order) can't be filtered by
    // record ID in filterByFormula — filter those in JS after fetching.
    const formulas: string[] = [];
    if (params.status) formulas.push(`{Status} = '${params.status}'`);
    if (params.isMissing !== undefined)
      formulas.push(`{IsMissing} = ${params.isMissing ? 1 : 0}`);
    // Search is handled entirely in JS (after fetch) so that lookup fields
    // like CustomerShippingMark and CustomerName are also searched correctly.
    // Do NOT push a formula for search here.

    const formula =
      formulas.length > 1
        ? `AND(${formulas.join(",")})`
        : formulas[0] ?? "";

    const records = await getAllRecords(TABLES.ITEMS, formula || undefined, [{ field: "DateReceived", direction: "desc" }]);
    let items = records.map(mapItem);

    // JS filters for linked record fields
    if (params.customerId)
      items = items.filter((item) => item.customerId === params.customerId);
    if (params.containerId)
      items = items.filter((item) => item.containerId === params.containerId);
    if (params.orderId)
      items = items.filter((item) => item.orderId === params.orderId);

    // JS filter for search on lookup fields (shipping mark, customer name)
    if (params.search) {
      const s = params.search.toLowerCase();
      items = items.filter(
        (item) =>
          item.itemRef?.toLowerCase().includes(s) ||
          item.description?.toLowerCase().includes(s) ||
          item.trackingNumber?.toLowerCase().includes(s) ||
          item.customerShippingMark?.toLowerCase().includes(s) ||
          item.customerName?.toLowerCase().includes(s)
      );
    }

    // CustomerName/CustomerShippingMark lookup fields may not exist in the base.
    // If any item is missing a name, batch-resolve from the Customers table.
    if (items.some((item) => item.customerId && !item.customerName)) {
      const allCustomers = await customersApi.list();
      const customerMap = new Map(allCustomers.map((c) => [c.id, c]));
      return items.map((item) => ({
        ...item,
        customerName: item.customerName ?? customerMap.get(item.customerId)?.name,
        customerShippingMark:
          item.customerShippingMark ?? customerMap.get(item.customerId)?.shippingMark,
      }));
    }

    return items;
  },

  async getById(id: string): Promise<Item> {
    const record = await getRecord(TABLES.ITEMS, id);
    const item = mapItem(record);
    if (item.customerId && !item.customerName) {
      const customer = await customersApi.getById(item.customerId).catch(() => null);
      if (customer) {
        item.customerName = customer.name;
        item.customerShippingMark = customer.shippingMark;
      }
    }
    return item;
  },

  async getByCustomer(customerId: string): Promise<Item[]> {
    return this.list({ customerId });
  },

  async create(
    input: CreateItemInput,
    createdByEmail: string
  ): Promise<Item> {
    // Generate sequential item ref
    const count = await countRecords(TABLES.ITEMS);
    const itemRef = generateItemRef(count + 1);

    const fields: FieldSet = {
      ItemRef: itemRef,
      DimensionUnit: input.dimensionUnit ?? "cm",
      Description: input.description,
      DateReceived: input.dateReceived,
      Customer: [input.customerId],
      Status: "Arrived at Transit Warehouse",
      IsMissing: false,
      Notes: input.notes ?? "",
      // CreatedAt is a "Created time" field — Airtable fills it automatically
      CreatedBy: createdByEmail,
    };
    if (input.weight !== undefined) fields["Weight"] = input.weight;
    if (input.shippingType) fields["FreightType"] = input.shippingType;
    if (input.length) fields["Length"] = input.length;
    if (input.width) fields["Width"] = input.width;
    if (input.height) fields["Height"] = input.height;
    if (input.trackingNumber) fields["TrackingNumber"] = input.trackingNumber;
    if (input.quantity) fields["Quantity"] = input.quantity;
    if (input.photoUrls && input.photoUrls.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields["Photos"] = input.photoUrls.map((url) => ({ url })) as any;
    }

    // Create with core fields first (guaranteed safe)
    const record = await createRecord(TABLES.ITEMS, fields);

    // Write pricing + special fields in a separate update so a field-name mismatch
    // never blocks item creation
    const pricingFields: FieldSet = {};
    if (input.estPrice !== undefined) pricingFields["EstPrice"] = input.estPrice;
    if (input.estShippingPrice !== undefined) pricingFields["EstShippingPrice"] = input.estShippingPrice;
    if (input.pkgEstShipping !== undefined) pricingFields["PkgEstShipping"] = input.pkgEstShipping;
    if (input.pkgShippingRate !== undefined) pricingFields["PkgShippingRate"] = input.pkgShippingRate;
    if (input.specialShippingRate !== undefined) pricingFields["SpecialShippingRate"] = input.specialShippingRate;
    if (input.isSpecialItem !== undefined) pricingFields["IsSpecialItem"] = input.isSpecialItem;
    if (input.specialRateName !== undefined) pricingFields["specialRateName"] = input.specialRateName;
    if (Object.keys(pricingFields).length > 0) {
      await updateRecord(TABLES.ITEMS, record.id, pricingFields).catch(() => {});
    }

    return mapItem(record);
  },

  async update(
    id: string,
    input: UpdateItemInput,
    updatedByEmail: string
  ): Promise<Item> {
    const fields: FieldSet = {};
    if (input.weight !== undefined) fields["Weight"] = input.weight;
    if (input.length !== undefined) fields["Length"] = input.length;
    if (input.width !== undefined) fields["Width"] = input.width;
    if (input.height !== undefined) fields["Height"] = input.height;
    if (input.description !== undefined) fields["Description"] = input.description;
    if (input.trackingNumber !== undefined)
      fields["TrackingNumber"] = input.trackingNumber;
    if (input.notes !== undefined) fields["Notes"] = input.notes;
    if (input.orderId !== undefined) fields["Order"] = [input.orderId];
    if (input.containerId !== undefined) fields["Container"] = [input.containerId];
    if (input.customerId !== undefined) fields["Customer"] = [input.customerId];
    if (input.isMissing !== undefined) fields["IsMissing"] = input.isMissing;
    if (input.estPrice !== undefined) fields["EstPrice"] = input.estPrice;
    if (input.estShippingPrice !== undefined) fields["EstShippingPrice"] = input.estShippingPrice;
    if (input.quantity !== undefined) fields["Quantity"] = input.quantity;
    if (input.shippingType !== undefined) fields["FreightType"] = input.shippingType;
    if (input.dimensionUnit !== undefined) fields["DimensionUnit"] = input.dimensionUnit;
    if (input.specialRateName !== undefined) fields["specialRateName"] = input.specialRateName;
    if (input.photoUrls !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields["Photos"] = input.photoUrls.map((url) => ({ url })) as any;
    }

    const record = await updateRecord(TABLES.ITEMS, id, fields);
    return mapItem(record);
  },

  async updateStatus(
    id: string,
    newStatus: ItemStatus,
    changedByEmail: string,
    changedByRole: UserRole,
    notes?: string,
    sendWhatsApp = false,
    skipContainerCheck = false
  ): Promise<Item> {
    const existing = await getRecord(TABLES.ITEMS, id);
    const previousStatus = existing.fields["Status"] as string;
    const itemRef = existing.fields["ItemRef"] as string;
    const customerId = ((existing.fields["Customer"] as string[]) ?? [])[0];

    // Validation: can only set "Shipped to Ghana" if item belongs to a container
    if (newStatus === "Shipped to Ghana" && !skipContainerCheck) {
      const containerId = (
        (existing.fields["Container"] as string[]) ?? []
      )[0];
      if (!containerId) {
        throw new BusinessError(
          "Item must be assigned to a container before marking as 'Shipped to Ghana'"
        );
      }
    }

    const statusUpdateFields: FieldSet = { Status: newStatus };
    // Clear the missing flag whenever an item is actively progressing
    if (["Arrived in Ghana", "Sorting", "Ready for Pickup", "Completed"].includes(newStatus)) {
      statusUpdateFields["IsMissing"] = false;
    }
    await updateRecord(TABLES.ITEMS, id, statusUpdateFields);

    // Log status history (awaited so Cloudflare Workers doesn't kill the promise)
    await statusHistoryApi.log({
      recordType: "Item",
      recordId: id,
      recordRef: itemRef,
      previousStatus,
      newStatus,
      changedBy: changedByEmail,
      changedByRole,
      changedAt: toISOString(),
      notes,
    });

    // Send WhatsApp notification only if explicitly requested
    const orderId = ((existing.fields["Order"] as string[]) ?? [])[0];
    if (sendWhatsApp && orderId && customerId) {
      try {
        const customer = await customersApi.getById(customerId);
        const order = await ordersApi.getById(orderId);
        const message = buildWhatsAppMessage(
          customer.name,
          order.orderRef,
          newStatus
        );
        // Trigger notification (Airtable automation handles this via webhook)
        await whatsAppApi.sendNotification({
          phone: customer.phone,
          customerName: customer.name,
          orderRef: order.orderRef,
          newStatus,
          message,
        });
      } catch {
        // WhatsApp notification failed (non-critical)
      }
    }

    const updated = await getRecord(TABLES.ITEMS, id);
    return mapItem(updated);
  },

  async markMissing(
    id: string,
    markedByEmail: string,
    markedByRole: UserRole
  ): Promise<Item> {
    await updateRecord(TABLES.ITEMS, id, { IsMissing: true });
    const updated = await getRecord(TABLES.ITEMS, id);
    return mapItem(updated);
  },

  async markFound(
    id: string,
    markedByEmail: string,
    markedByRole: UserRole
  ): Promise<Item> {
    // Explicitly clear the missing flag before updating status
    await updateRecord(TABLES.ITEMS, id, { IsMissing: false });
    return this.updateStatus(
      id,
      "Ready for Pickup",
      markedByEmail,
      markedByRole,
      "Item found during sorting"
    );
  },

  async delete(id: string): Promise<void> {
    // Unlink from container and order before deleting
    await updateRecord(TABLES.ITEMS, id, { Container: [], Order: [] });
    await deleteRecord(TABLES.ITEMS, id);
  },
};

// ============================================================
// ORDERS API
// ============================================================
export const ordersApi = {
  async list(params: OrderFilterParams = {}): Promise<Order[]> {
    const formulas: string[] = [];
    if (params.status) formulas.push(`{Status} = '${params.status}'`);
    if (params.search) {
      const s = escapeFormula(params.search.toLowerCase());
      // Only search fields that definitely exist (not lookup fields)
      formulas.push(`SEARCH('${s}', LOWER({OrderRef}))`);
    }

    const formula =
      formulas.length > 1
        ? `AND(${formulas.join(",")})`
        : formulas[0] ?? "";

    // Fetch orders and customers in parallel — CustomerName lookup is always undefined
    const [records, allCustomers] = await Promise.all([
      getAllRecords(TABLES.ORDERS, formula || undefined),
      customersApi.list(),
    ]);
    const customerMap = new Map(allCustomers.map((c) => [c.id, c]));
    let orders = records.map((r) => {
      const o = mapOrder(r);
      return { ...o, customerName: customerMap.get(o.customerId)?.name ?? o.customerName };
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (params.customerId)
      orders = orders.filter((order) => order.customerId === params.customerId);

    return orders;
  },

  async getById(id: string): Promise<Order> {
    const record = await getRecord(TABLES.ORDERS, id);
    const order = mapOrder(record);
    if (order.customerId && !order.customerName) {
      const customer = await customersApi.getById(order.customerId).catch(() => null);
      if (customer) order.customerName = customer.name;
    }
    return order;
  },

  async getByCustomer(customerId: string): Promise<Order[]> {
    return this.list({ customerId });
  },

  async create(
    input: CreateOrderInput,
    createdByEmail: string
  ): Promise<Order> {
    const count = await countRecords(TABLES.ORDERS);
    const orderRef = generateOrderRef(count + 1);

    const record = await createRecord(TABLES.ORDERS, {
      OrderRef: orderRef,
      Customer: [input.customerId],
      Items: input.itemIds,
      InvoiceAmount: input.invoiceAmount,
      Status: "Pending",
      InvoiceDate: input.invoiceDate,
      Notes: input.notes ?? "",
      // CreatedAt is a "Created time" field — Airtable fills it automatically
    });

    // Link order back to items
    for (const itemId of input.itemIds) {
      await updateRecord(TABLES.ITEMS, itemId, { Order: [record.id] });
    }

    return mapOrder(record);
  },

  async delete(id: string): Promise<void> {
    const existing = await getRecord(TABLES.ORDERS, id);
    const itemIds = (existing.fields["Items"] as string[]) ?? [];
    // Unlink all items from this order
    await Promise.all(
      itemIds.map((itemId) =>
        updateRecord(TABLES.ITEMS, itemId, { Order: [] }).catch(() => {})
      )
    );
    await deleteRecord(TABLES.ORDERS, id);
  },

  async update(
    id: string,
    input: UpdateOrderInput,
    updatedByEmail: string
  ): Promise<Order> {
    const existing = await getRecord(TABLES.ORDERS, id);
    const previousStatus = existing.fields["Status"] as string;
    const orderRef = existing.fields["OrderRef"] as string;

    const fields: FieldSet = {};
    if (input.invoiceAmount !== undefined)
      fields["InvoiceAmount"] = input.invoiceAmount;
    if (input.invoiceDate !== undefined) fields["InvoiceDate"] = input.invoiceDate;
    if (input.status !== undefined) fields["Status"] = input.status;
    if (input.notes !== undefined) fields["Notes"] = input.notes;
    if (input.itemIds !== undefined) fields["Items"] = input.itemIds;
    if (input.amountPaid !== undefined) fields["AmountPaid"] = input.amountPaid;
    if (input.balanceDue !== undefined) fields["BalanceDue"] = input.balanceDue;

    const record = await updateRecord(TABLES.ORDERS, id, fields);

    return mapOrder(record);
  },

  async storeKeepupIds(
    id: string,
    saleId: string,
    link?: string
  ): Promise<void> {
    const fields: FieldSet = { KeepupSaleId: saleId };
    if (link) fields["KeepupLink"] = link;
    await updateRecord(TABLES.ORDERS, id, fields);
  },

  async clearKeepupIds(id: string): Promise<void> {
    await updateRecord(TABLES.ORDERS, id, { KeepupSaleId: "", KeepupLink: "" });
  },
};

// ============================================================
// CONTAINERS API
// ============================================================
export const containersApi = {
  async list(params: ContainerFilterParams = {}): Promise<Container[]> {
    const formulas: string[] = [];
    if (params.status) formulas.push(`{Status} = '${params.status}'`);
    if (params.search) {
      const s = escapeFormula(params.search.toLowerCase());
      formulas.push(
        `OR(SEARCH('${s}', LOWER({ContainerID})), SEARCH('${s}', LOWER({Name})))`
      );
    }

    const formula =
      formulas.length > 1
        ? `AND(${formulas.join(",")})`
        : formulas[0] ?? "";

    const records = await getAllRecords(TABLES.CONTAINERS, formula || undefined);
    return records.map(mapContainer).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  },

  async getById(id: string): Promise<Container> {
    const record = await getRecord(TABLES.CONTAINERS, id);
    return mapContainer(record);
  },

  async getMany(ids: string[]): Promise<Container[]> {
    if (ids.length === 0) return [];
    const formula = ids.length === 1
      ? `RECORD_ID() = '${ids[0]}'`
      : `OR(${ids.map((id) => `RECORD_ID() = '${id}'`).join(",")})`;
    const records = await getAllRecords(TABLES.CONTAINERS, formula);
    return records.map(mapContainer);
  },

  async create(
    input: CreateContainerInput,
    createdByEmail: string
  ): Promise<Container> {
    let count = 0;
    try {
      count = await countRecords(TABLES.CONTAINERS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`[step1:countRecords] ${msg}`);
    }

    const containerId = generateContainerId(count + 1);

    const fields: FieldSet = {
      ContainerID: containerId,
      Status: "Loading",
      TrackingNumber: input.trackingNumber,
      CreatedBy: createdByEmail,
    };

    if (input.name) fields["Name"] = input.name;
    if (input.description) fields["Description"] = input.description;
    if (input.notes) fields["Notes"] = input.notes;
    if (input.eta) fields["DepartureDate"] = input.eta;

    let record: AirtableRecord<FieldSet>;
    try {
      record = await createRecord(TABLES.CONTAINERS, fields);
    } catch (e) {
      const airtableErr = e as Record<string, unknown>;
      const detail = [
        airtableErr?.["error"],
        airtableErr?.["message"],
        airtableErr?.["statusCode"],
      ]
        .filter(Boolean)
        .join(" | ");
      throw new Error(`[step2:createRecord] fields=${Object.keys(fields).join(",")} error=${detail || JSON.stringify(e)}`);
    }

    return mapContainer(record);
  },

  async update(
    id: string,
    input: UpdateContainerInput,
    updatedByEmail: string
  ): Promise<Container> {
    const fields: FieldSet = {};
    if (input.name !== undefined) fields["Name"] = input.name;
    if (input.description !== undefined) fields["Description"] = input.description;
    if (input.status !== undefined) fields["Status"] = input.status;
    if (input.eta !== undefined)
      fields["DepartureDate"] = input.eta;
    if (input.arrivalDate !== undefined) fields["ArrivalDate"] = input.arrivalDate;
    if (input.trackingNumber !== undefined)
      fields["TrackingNumber"] = input.trackingNumber;
    if (input.notes !== undefined) fields["Notes"] = input.notes;

    const record = await updateRecord(TABLES.CONTAINERS, id, fields);
    return mapContainer(record);
  },

  async updateStatus(
    id: string,
    newStatus: ContainerStatus,
    changedByEmail: string,
    changedByRole: UserRole,
    notes?: string
  ): Promise<Container> {
    const existing = await getRecord(TABLES.CONTAINERS, id);
    const previousStatus = existing.fields["Status"] as string;
    const containerId = existing.fields["ContainerID"] as string;
    const itemIds = (existing.fields["Items"] as string[]) ?? [];

    await updateRecord(TABLES.CONTAINERS, id, { Status: newStatus });

    // ---- CASCADE STATUS TO ALL ITEMS ----
    const containerToItemStatus: Partial<Record<ContainerStatus, ItemStatus>> = {
      "Shipped to Ghana": "Shipped to Ghana",
      "Arrived in Ghana": "Sorting",
      // "Loading" has no corresponding item status — no cascade
    };

    const targetItemStatus = containerToItemStatus[newStatus];

    if (targetItemStatus && itemIds.length > 0) {
      await Promise.all(
        itemIds.map(async (itemId) => {
          try {
            await itemsApi.updateStatus(
              itemId,
              targetItemStatus,
              changedByEmail,
              changedByRole,
              `Container ${containerId} → ${newStatus}`,
              false,
              true // skipContainerCheck — item is already in this container
            );
          } catch {
            // Failed to update item (non-fatal)
          }
        })
      );
    }

    const updated = await getRecord(TABLES.CONTAINERS, id);
    return mapContainer(updated);
  },

  async addItem(
    containerId: string,
    itemId: string,
    addedByEmail: string
  ): Promise<Container> {
    // Check if item is already in a different container
    let itemRecord: AirtableRecord<FieldSet>;
    try {
      itemRecord = await getRecord(TABLES.ITEMS, itemId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`[addItem:getItem] ${msg}`);
    }
    const existingContainerIds = (itemRecord.fields["Container"] as string[]) ?? [];
    if (existingContainerIds.length > 0 && !existingContainerIds.includes(containerId)) {
      throw new BusinessError("This item is already loaded into another container. Remove it from that container first.");
    }

    let container: AirtableRecord<FieldSet>;
    try {
      container = await getRecord(TABLES.CONTAINERS, containerId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`[addItem:getContainer] ${msg}`);
    }

    const currentItems = (container.fields["Items"] as string[]) ?? [];

    if (!currentItems.includes(itemId)) {
      currentItems.push(itemId);
      try {
        await updateRecord(TABLES.CONTAINERS, containerId, { Items: currentItems });
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        throw new Error(`[addItem:updateContainerItems] ${msg}`);
      }
    }

    try {
      await updateRecord(TABLES.ITEMS, itemId, { Container: [containerId] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`[addItem:updateItemContainer] ${msg}`);
    }

    const updated = await getRecord(TABLES.CONTAINERS, containerId);
    return mapContainer(updated);
  },

  async delete(id: string): Promise<void> {
    const existing = await getRecord(TABLES.CONTAINERS, id);
    const containerId = (existing.fields["ContainerID"] as string) ?? id;
    const itemIds = (existing.fields["Items"] as string[]) ?? [];
    // Unlink all items from this container before deleting
    await Promise.all(
      itemIds.map((itemId) =>
        updateRecord(TABLES.ITEMS, itemId, { Container: [] }).catch(() => {})
      )
    );
    await deleteRecord(TABLES.CONTAINERS, id);
  },

  async removeItem(
    containerId: string,
    itemId: string,
    removedByEmail: string
  ): Promise<Container> {
    const container = await getRecord(TABLES.CONTAINERS, containerId);
    const currentItems = (container.fields["Items"] as string[]) ?? [];
    const newItems = currentItems.filter((id) => id !== itemId);

    await updateRecord(TABLES.CONTAINERS, containerId, { Items: newItems });
    await updateRecord(TABLES.ITEMS, itemId, { Container: [] });

    const updated = await getRecord(TABLES.CONTAINERS, containerId);
    return mapContainer(updated);
  },
};

// ============================================================
// STATUS HISTORY API
// ============================================================
export const statusHistoryApi = {
  async log(entry: Omit<StatusHistory, "id">): Promise<void> {
    try {
      await createRecord(TABLES.STATUS_HISTORY, {
        RecordType: entry.recordType,
        RecordID: entry.recordId,
        RecordRef: entry.recordRef,
        PreviousStatus: entry.previousStatus,
        NewStatus: entry.newStatus,
        // ChangedBy is Email type in Airtable — only write if it looks like a valid email
        ...(entry.changedBy && entry.changedBy.includes("@")
          ? { ChangedBy: entry.changedBy }
          : {}),
        ChangedByRole: entry.changedByRole,
        ChangedAt: toISOString(),
        Notes: entry.notes ?? "",
      });
    } catch {
      // Non-fatal — status history logging should never block the main operation
    }
  },

  async getForRecord(
    recordId: string
  ): Promise<StatusHistory[]> {
    const records = await getAllRecords(
      TABLES.STATUS_HISTORY,
      `{RecordID} = '${recordId}'`
    );
    return records.map(mapStatusHistory).sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  },

  async getAll(): Promise<StatusHistory[]> {
    const records = await getAllRecords(TABLES.STATUS_HISTORY);
    return records.map(mapStatusHistory).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  },
};

// ============================================================
// ACTIVITY LOGS API
// ============================================================
export const activityLogsApi = {
  async log(
    entry: Omit<ActivityLog, "id" | "timestamp">
  ): Promise<void> {
    const fields: FieldSet = {
      Action: entry.action,
      UserEmail: entry.userEmail,
      UserRole: entry.userRole,
      Details: entry.details,
      EntityType: entry.entityType ?? "",
      EntityID: entry.entityId ?? "",
      Timestamp: toISOString(),
    };
    if (entry.ipAddress) fields["IPAddress"] = entry.ipAddress;
    await createRecord(TABLES.ACTIVITY_LOGS, fields);
  },

  async getAll(limit: number = 100): Promise<ActivityLog[]> {
    const records = await getAllRecords(TABLES.ACTIVITY_LOGS, undefined, [
      { field: "Timestamp", direction: "desc" },
    ]);
    return records.slice(0, limit).map(mapActivityLog);
  },
};

// ============================================================
// USERS API
// ============================================================
export const usersApi = {
  async getByFirebaseUid(uid: string): Promise<AppUser | null> {
    const records = await getAllRecords(TABLES.USERS, `{FirebaseUID} = '${escapeFormula(uid)}'`);
    if (records.length === 0) return null;
    return mapUser(records[0]);
  },

  async getByEmail(email: string): Promise<AppUser | null> {
    const records = await getAllRecords(TABLES.USERS, `{Email} = '${escapeFormula(email)}'`);
    if (records.length === 0) return null;
    return mapUser(records[0]);
  },

  // Enriches a customer AppUser with shippingMark + customerName from the Customers table.
  // Call this only at login time (POST /api/auth/verify), not on every request.
  async enrichCustomerUser(user: AppUser): Promise<AppUser> {
    if (user.role !== "customer" || !user.customerId) return user;
    const customer = await customersApi.getById(user.customerId).catch(() => null);
    if (!customer) return user;
    return {
      ...user,
      customerName: user.customerName ?? customer.name,
      shippingMark: customer.shippingMark,
      shippingAddress: customer.shippingAddress,
      phone: customer.phone,
      package: customer.package,
      preferredWarehouseId: customer.preferredWarehouseId,
    };
  },

  async create(
    firebaseUid: string,
    email: string,
    role: UserRole,
    customerId?: string
  ): Promise<AppUser> {
    const fields: FieldSet = {
      FirebaseUID: firebaseUid,
      Email: email,
      Role: role,
      // CreatedAt is a computed "Created time" field — Airtable fills it automatically
      LastLogin: toISOString(),
    };
    if (customerId) fields["CustomerRecord"] = [customerId];

    const record = await createRecord(TABLES.USERS, fields);
    return mapUser(record);
  },

  async updateLastLogin(id: string): Promise<void> {
    await updateRecord(TABLES.USERS, id, { LastLogin: toISOString() });
  },

  async countAll(): Promise<number> {
    return countRecords(TABLES.USERS);
  },

  async listStaff(): Promise<AppUser[]> {
    const records = await getAllRecords(
      TABLES.USERS,
      `OR({Role} = 'super_admin', {Role} = 'warehouse_staff')`
    );
    return records.map(mapUser);
  },

  async listAll(): Promise<AppUser[]> {
    const records = await getAllRecords(TABLES.USERS, undefined, [
      { field: "LastLogin", direction: "desc" },
    ]);
    return records.map(mapUser);
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(TABLES.USERS, id);
  },

  async deleteByCustomerId(customerId: string): Promise<void> {
    const records = await getAllRecords(TABLES.USERS, `FIND('${escapeFormula(customerId)}', ARRAYJOIN({CustomerRecord}))`);
    await Promise.all(records.map((r) => deleteRecord(TABLES.USERS, r.id)));
  },
};

// ============================================================
// WHATSAPP NOTIFICATION API
// Uses WhatsApp Business API directly OR triggers Airtable automation
// ============================================================
export const whatsAppApi = {
  async sendNotification(payload: {
    phone: string;
    customerName: string;
    orderRef: string;
    newStatus: string;
    message: string;
  }): Promise<void> {
    // Option 1: Direct WhatsApp Business API
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (accessToken && phoneNumberId) {
      try {
        const phoneNumber = payload.phone.replace(/\D/g, "");
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: phoneNumber,
              type: "text",
              text: { body: payload.message },
            }),
          }
        );

      } catch {
        // Failed to send WhatsApp message (non-critical)
      }
    } else {
      // Airtable automation handles WhatsApp notifications via status change triggers
    }
  },
};

// ============================================================
// DASHBOARD AGGREGATES
// ============================================================
export const dashboardApi = {
  async getAdminStats() {
    const [
      allCustomers,
      allItems,
      allContainers,
      allOrders,
    ] = await Promise.all([
      getAllRecords(TABLES.CUSTOMERS),
      getAllRecords(TABLES.ITEMS),
      getAllRecords(TABLES.CONTAINERS),
      getAllRecords(TABLES.ORDERS),
    ]);

    const activeCustomers = allCustomers.filter(
      (r) => r.fields["Status"] === "active"
    ).length;

    const itemsInWarehouse = allItems.filter(
      (r) => r.fields["Status"] === "Arrived at Transit Warehouse"
    ).length;

    const containersInTransit = allContainers.filter(
      (r) => r.fields["Status"] === "Shipped to Ghana"
    ).length;

    const itemsInSorting = allItems.filter(
      (r) => r.fields["Status"] === "Sorting"
    ).length;

    const lostItems = allItems.filter(
      (r) => r.fields["IsMissing"] === true
    ).length;

    const totalRevenue = allOrders
      .filter((r) => r.fields["Status"] === "Paid")
      .reduce((sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0), 0);

    const pendingRevenue = allOrders
      .filter((r) => r.fields["Status"] === "Pending")
      .reduce((sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0), 0);

    const readyForPickup = allItems.filter(
      (r) => r.fields["Status"] === "Ready for Pickup"
    ).length;

    const itemsByStatus: Partial<Record<string, number>> = {};
    for (const r of allItems) {
      const s = (r.fields["Status"] as string) ?? "Unknown";
      itemsByStatus[s] = (itemsByStatus[s] ?? 0) + 1;
    }

    // Return ALL pending orders (not capped) so client can filter by period
    const pendingOrders = allOrders
      .filter((r) => r.fields["Status"] === "Pending")
      .sort(
        (a, b) =>
          new Date(b.fields["CreatedAt"] as string).getTime() -
          new Date(a.fields["CreatedAt"] as string).getTime()
      )
      .map(mapOrder);

    const totalCbm = allItems.reduce((sum, r) => {
      const l = r.fields["Length"] as number;
      const w = r.fields["Width"] as number;
      const h = r.fields["Height"] as number;
      if (!l || !w || !h) return sum;
      const factor = (r.fields["DimensionUnit"] as string) === "inches" ? 16.387064 : 1;
      return sum + (l * w * h * factor) / 1_000_000;
    }, 0);

    // ordersThisMonth: count orders where InvoiceDate (or CreatedAt) is in current month/year
    const now = new Date();
    const ordersThisMonth = allOrders.filter((r) => {
      const raw = (r.fields["InvoiceDate"] as string) || (r.fields["CreatedAt"] as string);
      if (!raw) return false;
      const d = new Date(raw);
      return !isNaN(d.getTime()) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;

    // recentOrders: last 5 orders by CreatedAt desc
    const recentOrders = [...allOrders]
      .sort(
        (a, b) =>
          new Date((b.fields["CreatedAt"] as string) ?? 0).getTime() -
          new Date((a.fields["CreatedAt"] as string) ?? 0).getTime()
      )
      .slice(0, 5)
      .map((r) => {
        const f = r.fields;
        return {
          id: r.id,
          orderRef: (f["OrderRef"] as string) ?? "",
          customerName: (f["CustomerName"] as string) ?? undefined,
          invoiceAmount: (f["InvoiceAmount"] as number) ?? 0,
          invoiceDate: (f["InvoiceDate"] as string) || (f["CreatedAt"] as string) || "",
          status: (f["Status"] as string) ?? "",
          itemCount: ((f["Items"] as string[]) ?? []).length,
        };
      });

    // recentShipments: last 5 items by DateReceived desc
    const recentShipments = [...allItems]
      .sort(
        (a, b) =>
          new Date((b.fields["DateReceived"] as string) ?? 0).getTime() -
          new Date((a.fields["DateReceived"] as string) ?? 0).getTime()
      )
      .slice(0, 5)
      .map((r) => {
        const f = r.fields;
        const rawCustomerName = f["CustomerName"];
        const customerName = Array.isArray(rawCustomerName)
          ? (rawCustomerName as string[])[0]
          : (rawCustomerName as string | undefined);
        return {
          id: r.id,
          itemRef: (f["ItemRef"] as string) ?? "",
          customerName,
          containerName: (f["ContainerName"] as string) ?? undefined,
          status: (f["Status"] as string) ?? "",
          trackingNumber: (f["TrackingNumber"] as string) ?? undefined,
          dateReceived: (f["DateReceived"] as string) ?? "",
        };
      });

    return {
      totalCustomers: allCustomers.length,
      activeCustomers,
      itemsInWarehouse,
      containersInTransit,
      itemsInSorting,
      lostItems,
      readyForPickup,
      totalRevenue,
      pendingRevenue,
      totalCbm,
      itemsByStatus,
      pendingOrders,
      ordersThisMonth,
      recentOrders,
      recentShipments,
    };
  },

  async getCustomerStats(customerId: string) {
    const [items, orders] = await Promise.all([
      itemsApi.getByCustomer(customerId),
      ordersApi.getByCustomer(customerId),
    ]);

    // Attach container ETA to items
    const containerIds = [...new Set(items.map((i) => i.containerId).filter(Boolean) as string[])];
    if (containerIds.length > 0) {
      const containers = await containersApi.getMany(containerIds);
      const etaMap = new Map(containers.map((c) => [c.id, c.eta] as [string, string | undefined]));
      for (const item of items) {
        if (item.containerId) item.containerEta = etaMap.get(item.containerId);
      }
    }

    const itemsByStatus = items.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const pendingPayment = orders
      .filter((o) => o.status === "Pending")
      .reduce((sum, o) => sum + o.invoiceAmount, 0);

    const totalCbm = items.reduce((sum, item) => {
      if (!item.length || !item.width || !item.height) return sum;
      const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
      return sum + (item.length * item.width * item.height * factor) / 1_000_000;
    }, 0);

    return {
      totalItems: items.length,
      itemsByStatus,
      totalOrders: orders.length,
      pendingPayment,
      totalCbm,
      // Return full lists so client can apply period filters to cards
      recentItems: items,
      recentOrders: orders,
    };
  },
};

// ============================================================
// SUPPLIERS API
// ============================================================
function mapSupplier(record: AirtableRecord<FieldSet>): Supplier {
  const f = record.fields;
  return {
    id: record.id,
    supplierId: (f["SupplierID"] as string) ?? record.id,
    name: (f["Name"] as string) ?? "",
    category: (f["Category"] as Supplier["category"]) ?? undefined,
    platform: (f["Platform"] as Supplier["platform"]) ?? undefined,
    platformLink: (f["PlatformLink"] as string) ?? undefined,
    contact: (f["Contact"] as string) ?? undefined,
    contactMethod: (f["ContactMethod"] as string) ?? undefined,
    rating: (f["Rating"] as number) ?? undefined,
    notes: (f["Notes"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
    createdBy: (f["CreatedBy"] as string) ?? undefined,
  };
}

export const suppliersApi = {
  async list(search?: string): Promise<Supplier[]> {
    let formula: string | undefined;
    if (search) {
      const s = escapeFormula(search.toLowerCase());
      formula = `OR(SEARCH('${s}', LOWER({Name})), SEARCH('${s}', LOWER({Category})), SEARCH('${s}', LOWER({Platform})))`;
    }
    const records = await getAllRecords(TABLES.SUPPLIERS, formula, [
      { field: "CreatedAt", direction: "desc" },
    ]);
    return records.map(mapSupplier);
  },

  async getById(id: string): Promise<Supplier> {
    const record = await getRecord(TABLES.SUPPLIERS, id);
    return mapSupplier(record);
  },

  async create(input: CreateSupplierInput, createdByEmail: string): Promise<Supplier> {
    const count = await countRecords(TABLES.SUPPLIERS);
    const supplierId = generateSupplierId(count + 1);

    const fields: FieldSet = {
      SupplierID: supplierId,
      Name: input.name,
      CreatedBy: createdByEmail,
      CreatedAt: toISOString(),
    };
    if (input.category) fields["Category"] = input.category;
    if (input.platform) fields["Platform"] = input.platform;
    if (input.platformLink) fields["PlatformLink"] = input.platformLink;
    if (input.contact) fields["Contact"] = input.contact;
    if (input.contactMethod) fields["ContactMethod"] = input.contactMethod;
    if (input.rating !== undefined) fields["Rating"] = input.rating;
    if (input.notes) fields["Notes"] = input.notes;

    const record = await createRecord(TABLES.SUPPLIERS, fields);
    return mapSupplier(record);
  },

  async update(id: string, input: UpdateSupplierInput): Promise<Supplier> {
    const fields: FieldSet = {};
    if (input.name !== undefined) fields["Name"] = input.name;
    if (input.category !== undefined) fields["Category"] = input.category;
    if (input.platform !== undefined) fields["Platform"] = input.platform;
    if (input.platformLink !== undefined) fields["PlatformLink"] = input.platformLink;
    if (input.contact !== undefined) fields["Contact"] = input.contact;
    if (input.contactMethod !== undefined) fields["ContactMethod"] = input.contactMethod;
    if (input.rating !== undefined) fields["Rating"] = input.rating;
    if (input.notes !== undefined) fields["Notes"] = input.notes;

    const record = await updateRecord(TABLES.SUPPLIERS, id, fields);
    return mapSupplier(record);
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(TABLES.SUPPLIERS, id);
  },
};

// ============================================================
// WAREHOUSES API
// ============================================================
function mapWarehouse(record: AirtableRecord<FieldSet>): Warehouse {
  const f = record.fields;
  return {
    id: record.id,
    name: (f["Name"] as string) ?? "",
    address: (f["Address"] as string) ?? "",
    country: (f["Country"] as string) ?? undefined,
    phone: (f["Phone"] as string) ?? undefined,
    isActive: (f["IsActive"] as boolean) ?? true,
    createdAt: (f["CreatedAt"] as string) ?? (record as any)._rawJson?.createdTime ?? "",
  };
}

export const warehousesApi = {
  async list(): Promise<Warehouse[]> {
    const records = await getAllRecords(TABLES.WAREHOUSES);
    return records.map(mapWarehouse).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async listActive(): Promise<Warehouse[]> {
    const records = await getAllRecords(TABLES.WAREHOUSES, `{IsActive} = 1`);
    return records.map(mapWarehouse).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async create(input: CreateWarehouseInput): Promise<Warehouse> {
    const fields: FieldSet = {
      Name: input.name,
      Address: input.address,
      IsActive: true,
      CreatedAt: toISOString(),
    };
    if (input.country) fields["Country"] = input.country;
    if (input.phone) fields["Phone"] = input.phone;
    const record = await createRecord(TABLES.WAREHOUSES, fields);
    return mapWarehouse(record);
  },

  async toggleActive(id: string, isActive: boolean): Promise<Warehouse> {
    const record = await updateRecord(TABLES.WAREHOUSES, id, { IsActive: isActive });
    return mapWarehouse(record);
  },

  async update(id: string, input: Partial<{ name: string; address: string; country: string; phone: string }>): Promise<Warehouse> {
    const fields: FieldSet = {};
    if (input.name !== undefined) fields["Name"] = input.name;
    if (input.address !== undefined) fields["Address"] = input.address;
    if (input.country !== undefined) fields["Country"] = input.country;
    if (input.phone !== undefined) fields["Phone"] = input.phone;
    const record = await updateRecord(TABLES.WAREHOUSES, id, fields);
    return mapWarehouse(record);
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(TABLES.WAREHOUSES, id);
  },
};

// ============================================================
// SPECIAL RATES API
// ============================================================
export interface SpecialRate {
  id: string;
  name: string;
  sea: number;
  air: number;
}

function mapSpecialRate(record: AirtableRecord<FieldSet>): SpecialRate {
  const f = record.fields;
  return {
    id: record.id,
    name: (f["Name"] as string) ?? "",
    sea: (f["Sea"] as number) ?? 0,
    air: (f["Air"] as number) ?? 0,
  };
}

export const specialRatesApi = {
  async list(): Promise<SpecialRate[]> {
    const records = await getAllRecords(TABLES.SPECIAL_RATES);
    return records.map(mapSpecialRate);
  },

  async create(input: { name: string; sea: number; air: number }): Promise<SpecialRate> {
    const record = await createRecord(TABLES.SPECIAL_RATES, {
      Name: input.name,
      Sea: input.sea,
      Air: input.air,
    });
    return mapSpecialRate(record);
  },

  async update(id: string, input: { name: string; sea: number; air: number }): Promise<SpecialRate> {
    const record = await updateRecord(TABLES.SPECIAL_RATES, id, {
      Name: input.name,
      Sea: input.sea,
      Air: input.air,
    });
    return mapSpecialRate(record);
  },

  async delete(id: string): Promise<void> {
    await deleteRecord(TABLES.SPECIAL_RATES, id);
  },
};

// ============================================================
// PACKAGE RATES API
// Stores one record per tier: basic, business, enterprise, special
// ============================================================
export interface PackageRateRecord {
  id: string;
  tier: string;
  sea: number;
  air: number;
}

export interface PackageRates {
  basic: { sea: number; air: number };
  business: { sea: number; air: number };
  enterprise: { sea: number; air: number };
  special: { sea: number; air: number };
}

export const DEFAULT_PACKAGE_RATES: PackageRates = {
  basic: { sea: 350, air: 8 },
  business: { sea: 280, air: 6 },
  enterprise: { sea: 450, air: 12 },
  special: { sea: 500, air: 15 },
};

function mapPackageRateRecord(record: AirtableRecord<FieldSet>): PackageRateRecord {
  const f = record.fields;
  return {
    id: record.id,
    tier: (f["Tier"] as string) ?? "",
    sea: (f["Sea"] as number) ?? 0,
    air: (f["Air"] as number) ?? 0,
  };
}

export const packageRatesApi = {
  async getAll(): Promise<PackageRates> {
    const records = await getAllRecords(TABLES.PACKAGE_RATES);
    const result: PackageRates = { ...DEFAULT_PACKAGE_RATES };
    for (const r of records) {
      const rec = mapPackageRateRecord(r);
      const tier = rec.tier as keyof PackageRates;
      if (tier in result) {
        result[tier] = { sea: rec.sea, air: rec.air };
      }
    }
    return result;
  },

  async upsertTier(tier: string, sea: number, air: number): Promise<void> {
    const records = await getAllRecords(TABLES.PACKAGE_RATES, `{Tier} = '${escapeFormula(tier)}'`);
    if (records.length > 0) {
      await updateRecord(TABLES.PACKAGE_RATES, records[0].id, { Sea: sea, Air: air });
    } else {
      await createRecord(TABLES.PACKAGE_RATES, { Tier: tier, Sea: sea, Air: air });
    }
  },

  async saveAll(rates: PackageRates): Promise<void> {
    const tiers = Object.keys(rates) as (keyof PackageRates)[];
    await Promise.all(tiers.map((tier) => packageRatesApi.upsertTier(tier, rates[tier].sea, rates[tier].air)));
  },
};

export interface AppSettings {
  usdToGhs: number;
  shippingRatePerCbm: number;
}

export const settingsApi = {
  async get(): Promise<AppSettings | null> {
    const records = await getAllRecords(TABLES.SETTINGS);
    if (records.length === 0) return null;
    const f = records[0].fields;
    return {
      usdToGhs: (f["UsdToGhs"] as number) ?? 1,
      shippingRatePerCbm: (f["ShippingRatePerCbm"] as number) ?? 0,
    };
  },

  async save(settings: AppSettings): Promise<void> {
    const records = await getAllRecords(TABLES.SETTINGS);
    if (records.length > 0) {
      await updateRecord(TABLES.SETTINGS, records[0].id, {
        UsdToGhs: settings.usdToGhs,
        ShippingRatePerCbm: settings.shippingRatePerCbm,
      });
    } else {
      await createRecord(TABLES.SETTINGS, {
        UsdToGhs: settings.usdToGhs,
        ShippingRatePerCbm: settings.shippingRatePerCbm,
      });
    }
  },
};

// Re-export types for convenience
export type { ItemPhoto };
