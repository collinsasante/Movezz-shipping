import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, parseISO, isValid } from "date-fns";
import type { ItemStatus } from "@/types";

// ---- Tailwind class merge utility ----
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---- Shipping Mark Generator ----
// Format: PAKKMAXX-{LAST4DIGITS}-{FIRSTNAME}
// Example: PAKKMAXX-4821-COLLINS
export function generateShippingMark(name: string, phone: string): string {
  const firstName = name.trim().split(" ")[0].toUpperCase().replace(/[^A-Z]/g, "");
  const last4 = phone.replace(/\D/g, "").slice(-4);
  return `PAKKMAXX-${last4}-${firstName}`;
}

// ---- Shipping Address Generator ----
// A unique readable address based on shipping mark
export function generateShippingAddress(shippingMark: string): string {
  return `${shippingMark}, Pakkmaxx Warehouse, Accra, Ghana`;
}

// ---- Auto ID Generators ----
export function generateContainerId(sequenceNumber: number): string {
  const year = new Date().getFullYear();
  const padded = String(sequenceNumber).padStart(3, "0");
  return `PMX-CON-${year}-${padded}`;
}

export function generateOrderRef(sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(5, "0");
  return `ORD-${padded}`;
}

export function generateItemRef(sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(4, "0");
  return `ITM-${padded}`;
}

export function generateSupplierId(sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(4, "0");
  return `SUP-${padded}`;
}

// ---- Date Formatting ----
export function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "N/A";
  try {
    const date = parseISO(dateStr);
    if (!isValid(date)) return "Invalid Date";
    return format(date, "MMM dd, yyyy");
  } catch {
    return "Invalid Date";
  }
}

export function formatDateTime(dateStr: string | undefined | null): string {
  if (!dateStr) return "N/A";
  try {
    const date = parseISO(dateStr);
    if (!isValid(date)) return "Invalid Date";
    if (!dateStr.includes("T")) return format(date, "MMM dd, yyyy");
    return format(date, "MMM dd, yyyy HH:mm");
  } catch {
    return "Invalid Date";
  }
}

export function toISOString(date: Date = new Date()): string {
  return date.toISOString();
}

// ---- Currency Formatting ----
export function formatCurrency(
  amount: number,
  currency: string = "GHS"
): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

// ---- Status Color Mapping ----
export function getStatusColor(status: ItemStatus | string): string {
  const map: Record<string, string> = {
    "Arrived at Transit Warehouse": "bg-blue-100 text-blue-800 border-blue-200",
    "Shipped to Ghana": "bg-indigo-100 text-indigo-800 border-indigo-200",
    "Arrived in Ghana": "bg-purple-100 text-purple-800 border-purple-200",
    Sorting: "bg-yellow-100 text-yellow-800 border-yellow-200",
    "Ready for Pickup": "bg-green-100 text-green-800 border-green-200",
    Completed: "bg-gray-100 text-gray-700 border-gray-200",
    // Container
    Loading: "bg-orange-100 text-orange-800 border-orange-200",
    // Order
    Pending: "bg-amber-100 text-amber-800 border-amber-200",
    Paid: "bg-emerald-100 text-emerald-800 border-emerald-200",
    // Customer
    active: "bg-green-100 text-green-800 border-green-200",
    inactive: "bg-red-100 text-red-800 border-red-200",
    Active: "bg-green-100 text-green-800 border-green-200",
    Inactive: "bg-red-100 text-red-800 border-red-200",
  };
  return map[status] ?? "bg-gray-100 text-gray-600 border-gray-200";
}

// ---- Status Step Index (for timeline) ----
export const ITEM_STATUS_STEPS: ItemStatus[] = [
  "Arrived at Transit Warehouse",
  "Shipped to Ghana",
  "Arrived in Ghana",
  "Sorting",
  "Ready for Pickup",
  "Completed",
];

export function getStatusStepIndex(status: ItemStatus): number {
  return ITEM_STATUS_STEPS.indexOf(status);
}

// ---- WhatsApp Message Template ----
export function buildWhatsAppMessage(
  customerName: string,
  orderRef: string,
  newStatus: ItemStatus | string
): string {
  return `Hello ${customerName}, your package ${orderRef} is now *${newStatus}*. Thank you for choosing Pakkmaxx! 📦`;
}

// ---- Phone Number Normalizer ----
// Ensures WhatsApp-compatible format with country code
export function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // If starts with 0, assume Ghana (+233)
  if (digits.startsWith("0") && digits.length === 10) {
    return `+233${digits.slice(1)}`;
  }
  // If already has country code
  if (digits.length > 10) {
    return `+${digits}`;
  }
  return phone;
}

// ---- Pagination Helper ----
export function calculatePagination(
  total: number,
  page: number,
  pageSize: number
) {
  const totalPages = Math.ceil(total / pageSize);
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasMore: page < totalPages,
    from: (page - 1) * pageSize + 1,
    to: Math.min(page * pageSize, total),
  };
}

// ---- Safe JSON parse ----
export function safeJson<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ---- Truncate string ----
export function truncate(str: string, maxLength: number = 50): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}...`;
}

// ---- Volume calculator ----
export function calculateVolume(
  length: number,
  width: number,
  height: number
): number {
  return parseFloat((length * width * height).toFixed(3));
}
