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
} from "@/types";
import {
  generateShippingMark,
  generateShippingAddress,
  generateContainerId,
  generateOrderRef,
  generateItemRef,
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
    Airtable.configure({ apiKey });
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

} as const;

// ============================================================
// GENERIC HELPERS
// ============================================================
async function getAllRecords(
  tableName: string,
  formula?: string,
  sort?: { field: string; direction: "asc" | "desc" }[]
): Promise<AirtableRecord<FieldSet>[]> {
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
}

async function getRecord(
  tableName: string,
  id: string
): Promise<AirtableRecord<FieldSet>> {
  const base = getBase();
  return base(tableName).find(id);
}

async function createRecord(
  tableName: string,
  fields: FieldSet
): Promise<AirtableRecord<FieldSet>> {
  const base = getBase();
  return base(tableName).create(fields);
}

async function updateRecord(
  tableName: string,
  id: string,
  fields: FieldSet
): Promise<AirtableRecord<FieldSet>> {
  const base = getBase();
  return base(tableName).update(id, fields);
}

async function deleteRecord(tableName: string, id: string): Promise<void> {
  const base = getBase();
  await base(tableName).destroy(id);
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
    package: ((f["CustomerPackage"] as string) ?? undefined) as Customer["package"],
    exchangeRate: (f["ExchangeRate"] as number) ?? undefined,
    notes: (f["Notes"] as string) ?? undefined,
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
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
    createdAt: (f["CreatedAt"] as string) ?? toISOString(),
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
    const customers = records.map(mapCustomer);

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
    if (params.search) {
      const s = escapeFormula(params.search.toLowerCase());
      // Only search plain text fields — lookup fields (CustomerShippingMark, CustomerName)
      // are array-typed and can cause formula errors; filter those in JS below.
      formulas.push(
        `OR(SEARCH('${s}', LOWER({Description})), SEARCH('${s}', LOWER({TrackingNumber})), SEARCH('${s}', LOWER({ItemRef})))`
      );
    }

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
    console.log("[itemsApi.getById] customerName:", item.customerName, "customerId:", item.customerId);
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

    const record = await createRecord(TABLES.ITEMS, fields);

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
    if (input.isMissing !== undefined) fields["IsMissing"] = input.isMissing;
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

    await updateRecord(TABLES.ITEMS, id, { Status: newStatus });

    // Log status history (non-fatal)
    statusHistoryApi.log({
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
      } catch (err) {
        console.error("WhatsApp notification failed (non-critical):", err);
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
    });

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
        updateRecord(TABLES.ITEMS, itemId, { Order: [] }).catch((e) =>
          console.error(`Failed to unlink item ${itemId} from order:`, e)
        )
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
    if (input.status !== undefined) fields["Status"] = input.status;
    if (input.notes !== undefined) fields["Notes"] = input.notes;
    if (input.itemIds !== undefined) fields["Items"] = input.itemIds;

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
    return records.map(mapContainer);
  },

  async getById(id: string): Promise<Container> {
    const record = await getRecord(TABLES.CONTAINERS, id);
    return mapContainer(record);
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

    console.log(`[cascade] container ${containerId}: ${previousStatus} → ${newStatus}`);
    console.log(`[cascade] items in container:`, itemIds);

    await updateRecord(TABLES.CONTAINERS, id, { Status: newStatus });
    console.log(`[cascade] container status updated OK`);

    // ---- CASCADE STATUS TO ALL ITEMS ----
    const containerToItemStatus: Partial<Record<ContainerStatus, ItemStatus>> = {
      "Shipped to Ghana": "Shipped to Ghana",
      "Arrived in Ghana": "Sorting",
      "Completed": "Completed",
      // "Loading" has no corresponding item status — no cascade
    };

    const targetItemStatus = containerToItemStatus[newStatus];
    console.log(`[cascade] targetItemStatus:`, targetItemStatus ?? "none (no cascade for this status)");

    if (targetItemStatus && itemIds.length > 0) {
      await Promise.all(
        itemIds.map(async (itemId) => {
          console.log(`[cascade] updating item ${itemId} → ${targetItemStatus}`);
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
            console.log(`[cascade] item ${itemId} updated OK`);
          } catch (err) {
            console.error(`[cascade] FAILED to update item ${itemId}:`, err);
          }
        })
      );
    } else if (!targetItemStatus) {
      console.log(`[cascade] skipping — no item status mapped for container status "${newStatus}"`);
    } else {
      console.log(`[cascade] skipping — container has no items`);
    }

    const updated = await getRecord(TABLES.CONTAINERS, id);
    return mapContainer(updated);
  },

  async addItem(
    containerId: string,
    itemId: string,
    addedByEmail: string
  ): Promise<Container> {
    console.log("[addItem] containerId:", containerId, "itemId:", itemId);

    let container: AirtableRecord<FieldSet>;
    try {
      container = await getRecord(TABLES.CONTAINERS, containerId);
      console.log("[addItem] fetched container OK, Items field:", JSON.stringify(container.fields["Items"]));
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`[addItem:getContainer] ${msg}`);
    }

    const currentItems = (container.fields["Items"] as string[]) ?? [];

    if (!currentItems.includes(itemId)) {
      currentItems.push(itemId);
      try {
        await updateRecord(TABLES.CONTAINERS, containerId, { Items: currentItems });
        console.log("[addItem] updated container Items OK");
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        throw new Error(`[addItem:updateContainerItems] ${msg}`);
      }
    } else {
      console.log("[addItem] item already in container Items list");
    }

    try {
      await updateRecord(TABLES.ITEMS, itemId, { Container: [containerId] });
      console.log("[addItem] updated item Container field OK");
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
        updateRecord(TABLES.ITEMS, itemId, { Container: [] }).catch((e) =>
          console.error(`Failed to unlink item ${itemId} from container:`, e)
        )
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
    } catch (err) {
      // Non-fatal — status history logging should never block the main operation
      console.error("[statusHistory] Failed to log entry (non-fatal):", err);
    }
  },

  async getForRecord(
    recordId: string
  ): Promise<StatusHistory[]> {
    const records = await getAllRecords(
      TABLES.STATUS_HISTORY,
      `{RecordID} = '${recordId}'`,
      [{ field: "ChangedAt", direction: "asc" }]
    );
    return records.map(mapStatusHistory);
  },

  async getAll(): Promise<StatusHistory[]> {
    const records = await getAllRecords(TABLES.STATUS_HISTORY, undefined, [
      { field: "ChangedAt", direction: "desc" },
    ]);
    return records.map(mapStatusHistory);
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

        if (!response.ok) {
          const err = await response.json();
          console.error("WhatsApp API error:", err);
        }
      } catch (err) {
        console.error("Failed to send WhatsApp message:", err);
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

    const pendingOrders = allOrders
      .filter((r) => r.fields["Status"] === "Pending")
      .sort(
        (a, b) =>
          new Date(b.fields["CreatedAt"] as string).getTime() -
          new Date(a.fields["CreatedAt"] as string).getTime()
      )
      .slice(0, 8)
      .map(mapOrder);

    const totalCbm = allItems.reduce((sum, r) => {
      const l = r.fields["Length"] as number;
      const w = r.fields["Width"] as number;
      const h = r.fields["Height"] as number;
      if (!l || !w || !h) return sum;
      const factor = (r.fields["DimensionUnit"] as string) === "inches" ? 16.387064 : 1;
      return sum + (l * w * h * factor) / 1_000_000;
    }, 0);

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
    };
  },

  async getCustomerStats(customerId: string) {
    const [items, orders] = await Promise.all([
      itemsApi.getByCustomer(customerId),
      ordersApi.getByCustomer(customerId),
    ]);

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
      recentItems: items.slice(0, 5),
      recentOrders: orders.slice(0, 5),
    };
  },
};

// Re-export types for convenience
export type { ItemPhoto };
