// ============================================================
// PAKKMAXX - Core TypeScript Types
// ============================================================

// ---- ROLES ----
export type UserRole = "super_admin" | "warehouse_staff" | "customer";

// ---- ITEM STATUS ----
export type ItemStatus =
  | "Arrived at Transit Warehouse"
  | "Shipped to Ghana"
  | "Arrived in Ghana"
  | "Sorting"
  | "Ready for Pickup"
  | "Completed";

// ---- CONTAINER STATUS ----
export type ContainerStatus =
  | "Loading"
  | "Shipped to Ghana"
  | "Arrived in Ghana"
  | "Completed";

// ---- ORDER STATUS ----
export type OrderStatus = "Pending" | "Partial" | "Paid";

// ---- CUSTOMER STATUS ----
export type CustomerStatus = "active" | "inactive";

// ============================================================
// CUSTOMER
// ============================================================
export type CustomerPackage = "basic" | "business" | "enterprise" | "special";

export interface Customer {
  id: string; // Airtable record ID
  name: string;
  phone: string; // WhatsApp number (include country code e.g. +233...)
  email: string;
  shippingAddress: string; // Auto-generated
  shippingMark: string; // e.g. PAKKMAXX-COLLINS-4821
  firebaseUid?: string;
  status: CustomerStatus;
  shippingType?: "air" | "sea";
  package?: CustomerPackage;
  exchangeRate?: number;
  notes?: string;
  preferredWarehouseId?: string;
  createdAt: string;
  // Computed from linked records
  totalItems?: number;
  totalOrders?: number;
}

export interface CreateCustomerInput {
  name: string;
  phone: string;
  email: string;
  notes?: string;
  shippingAddress?: string;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  status?: CustomerStatus;
  shippingType?: "air" | "sea";
  package?: CustomerPackage;
  exchangeRate?: number | null;
  shippingAddress?: string;
  preferredWarehouseId?: string;
}

// ============================================================
// ITEM / PACKAGE
// ============================================================
export interface ItemPhoto {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
  thumbnails?: {
    small: { url: string; width: number; height: number };
    large: { url: string; width: number; height: number };
    full: { url: string; width: number; height: number };
  };
}

export interface Item {
  id: string; // Airtable record ID
  itemRef: string; // Human-readable ref, e.g. ITM-0001
  photos: ItemPhoto[];
  weight?: number; // in kg (optional for sea freight)
  shippingType?: "air" | "sea"; // freight type
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit: "cm" | "inches";
  description: string;
  dateReceived: string;
  trackingNumber?: string;
  customerId: string;
  customerName?: string;
  customerShippingMark?: string;
  status: ItemStatus;
  containerId?: string;
  containerName?: string;
  containerEta?: string;
  orderId?: string;
  orderRef?: string;
  isMissing: boolean;
  quantity?: number;
  estPrice?: number;
  estShippingPrice?: number;
  pkgEstShipping?: number;
  pkgShippingRate?: number;
  specialShippingRate?: number;
  isSpecialItem?: boolean;
  specialRateName?: string;
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

export interface CreateItemInput {
  photoUrls?: string[];
  weight?: number;
  shippingType?: "air" | "sea";
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: "cm" | "inches";
  description: string;
  dateReceived: string;
  trackingNumber?: string;
  customerId: string;
  quantity?: number;
  estPrice?: number;
  estShippingPrice?: number;
  pkgEstShipping?: number;
  pkgShippingRate?: number;
  specialShippingRate?: number;
  isSpecialItem?: boolean;
  specialRateName?: string;
  notes?: string;
}

export interface UpdateItemInput {
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: "cm" | "inches";
  description?: string;
  trackingNumber?: string;
  notes?: string;
  orderId?: string;
  containerId?: string;
  customerId?: string;
  isMissing?: boolean;
  photoUrls?: string[];
  estPrice?: number;
  estShippingPrice?: number;
  quantity?: number;
  shippingType?: "air" | "sea";
  specialRateName?: string;
  status?: string;
}

// ============================================================
// ORDER
// ============================================================
export interface Order {
  id: string;
  orderRef: string; // e.g. ORD-00001
  customerId: string;
  customerName?: string;
  itemIds: string[];
  items?: Item[];
  invoiceAmount: number;
  status: OrderStatus;
  invoiceDate: string;
  notes?: string;
  createdAt: string;
  keepupSaleId?: string;
  keepupLink?: string;
  createdBy?: string;
  customerPhone?: string;
  amountPaid?: number;
  balanceDue?: number;
}

export interface CreateOrderInput {
  customerId: string;
  itemIds: string[];
  invoiceAmount: number;
  invoiceDate: string;
  notes?: string;
}

export interface UpdateOrderInput {
  invoiceAmount?: number;
  invoiceDate?: string;
  status?: OrderStatus;
  notes?: string;
  itemIds?: string[];
  paymentAmount?: number;
  amountPaid?: number;
  balanceDue?: number;
}

// ============================================================
// CONTAINER
// ============================================================
export interface Container {
  id: string;
  containerId: string; // e.g. PMX-CON-2024-001
  name?: string; // Shipping Line (optional)
  description?: string;
  status: ContainerStatus;
  itemIds: string[];
  items?: Item[];
  itemCount?: number;
  eta?: string; // Estimated Time of Arrival (stored in DepartureDate Airtable field)
  arrivalDate?: string;
  trackingNumber: string; // Container Number (mandatory)
  notes?: string;
  createdAt: string;
  createdBy?: string;
  totalCbm?: number; // computed — sum of sea-freight item CBMs
}

export interface CreateContainerInput {
  name?: string; // Shipping Line (optional)
  description?: string;
  eta?: string;
  trackingNumber: string; // Container Number (mandatory)
  notes?: string;
}

export interface UpdateContainerInput {
  name?: string;
  description?: string;
  status?: ContainerStatus;
  eta?: string;
  arrivalDate?: string;
  trackingNumber?: string;
  notes?: string;
}

// ============================================================
// STATUS HISTORY (Audit Log)
// ============================================================
export interface StatusHistory {
  id: string;
  recordType: "Item" | "Container" | "Order";
  recordId: string;
  recordRef: string; // human-readable ref
  previousStatus: string;
  newStatus: string;
  changedBy: string; // email or name
  changedByRole: UserRole;
  changedAt: string;
  notes?: string;
}

// ============================================================
// ACTIVITY LOG
// ============================================================
export interface ActivityLog {
  id: string;
  action: string;
  userEmail: string;
  userRole: UserRole;
  details: string;
  entityType?: string;
  entityId?: string;
  timestamp: string;
  ipAddress?: string;
}

// ============================================================
// USER / AUTH
// ============================================================
export interface AppUser {
  id: string; // Airtable record ID
  firebaseUid: string;
  email: string;
  role: UserRole;
  customerId?: string; // Only for customers
  customerName?: string;
  shippingMark?: string;
  shippingAddress?: string;
  package?: CustomerPackage;
  preferredWarehouseId?: string;
  createdAt: string;
  lastLogin?: string;
}

export interface AuthSession {
  user: AppUser;
  token: string;
}

// ============================================================
// DASHBOARD STATS
// ============================================================
export interface AdminDashboardStats {
  totalCustomers: number;
  activeCustomers: number;
  itemsInWarehouse: number;
  containersInTransit: number;
  itemsInSorting: number;
  lostItems: number;
  readyForPickup: number;
  totalRevenue: number;
  pendingRevenue: number;
  totalCbm: number;
  itemsByStatus: Partial<Record<string, number>>;
  pendingOrders: Order[];
  ordersThisMonth: number;
  recentOrders: Array<{
    id: string;
    orderRef: string;
    customerName?: string;
    invoiceAmount: number;
    invoiceDate: string;
    status: string;
    itemCount: number;
  }>;
  recentShipments: Array<{
    id: string;
    itemRef: string;
    customerName?: string;
    containerName?: string;
    status: string;
    trackingNumber?: string;
    dateReceived: string;
  }>;
}

export interface CustomerDashboardStats {
  totalItems: number;
  itemsByStatus: Record<ItemStatus, number>;
  totalOrders: number;
  pendingPayment: number;
  totalCbm: number;
  recentItems: Item[];
  recentOrders: Order[];
}

// ============================================================
// API RESPONSE WRAPPERS
// ============================================================
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
    offset?: string; // Airtable uses cursor-based pagination
  };
}

// ============================================================
// WHATSAPP NOTIFICATION
// ============================================================
export interface WhatsAppNotification {
  phone: string;
  customerName: string;
  orderRef: string;
  newStatus: string;
  templateMessage: string;
}

// ============================================================
// SORTING
// ============================================================
export interface SortingItem extends Item {
  markedFoundAt?: string;
  markedFoundBy?: string;
  markedMissingAt?: string;
  markedMissingBy?: string;
}

// ============================================================
// WAREHOUSE
// ============================================================
export interface Warehouse {
  id: string;
  name: string;
  address: string;
  country?: string;
  phone?: string;
  isActive: boolean;
  createdAt: string;
}

export interface CreateWarehouseInput {
  name: string;
  address: string;
  country?: string;
  phone?: string;
}

// ============================================================
// SUPPLIER
// ============================================================
export type SupplierCategory =
  | "Electronics"
  | "Clothing"
  | "Footwear"
  | "Beauty"
  | "Home & Garden"
  | "Toys"
  | "Sports"
  | "Auto Parts"
  | "Food & Supplements"
  | "Other";

export type SupplierPlatform =
  | "1688"
  | "Alibaba"
  | "AliExpress"
  | "Taobao"
  | "DHgate"
  | "Pinduoduo"
  | "WeChat"
  | "Other";

export interface Supplier {
  id: string;
  supplierId: string; // e.g. SUP-0001
  name: string;
  category?: SupplierCategory;
  platform?: SupplierPlatform;
  platformLink?: string;
  contact?: string; // phone / WeChat / WhatsApp
  contactMethod?: string;
  rating?: number; // 1-5
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

export interface CreateSupplierInput {
  name: string;
  category?: SupplierCategory;
  platform?: SupplierPlatform;
  platformLink?: string;
  contact?: string;
  contactMethod?: string;
  rating?: number;
  notes?: string;
}

export interface UpdateSupplierInput {
  name?: string;
  category?: SupplierCategory;
  platform?: SupplierPlatform;
  platformLink?: string;
  contact?: string;
  contactMethod?: string;
  rating?: number;
  notes?: string;
}

// ============================================================
// FILTER / SEARCH PARAMS
// ============================================================
export interface ItemFilterParams {
  status?: ItemStatus;
  customerId?: string;
  containerId?: string;
  orderId?: string;
  isMissing?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface CustomerFilterParams {
  status?: CustomerStatus;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ContainerFilterParams {
  status?: ContainerStatus;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface OrderFilterParams {
  status?: OrderStatus;
  customerId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}
