// SYNTHETIC Airtable snapshot for the importer tests. Every name, e-mail, phone and amount below is invented; nothing was read from
// Airtable. The "messy" snapshot deliberately mixes valid records with every kind of invalid one; the "clean" snapshot has only
// records that import without a warning (so a READY verdict is reachable).
import { SNAPSHOT_FORMAT } from "../../../scripts/lib/import/snapshot.mjs";

const r = (id, fields) => ({ id, fields });
const iso = (d) => `${d}T08:00:00.000Z`;

/** @returns {{ format: string, source: any, tables: Record<string, any[]> }} */
function base(label) {
  return { format: SNAPSHOT_FORMAT, source: { kind: "fixture", label, capturedAt: "2026-03-01T00:00:00.000Z" }, tables: {} };
}

/** Valid core shared by both variants. */
/** @returns {Record<string, any[]>} */
function core() {
  /** @type {Record<string, any[]>} */
  const t = {};
  t.Warehouses = [r("recW1", { Name: "Amrahia Warehouse", Address: "Adenta-Dodowa Road", Country: "Ghana", IsActive: true })];
  t.Suppliers = [r("recS1", { SupplierID: "SUP-0001", Name: "Guangzhou Textiles", Category: "Clothing", Rating: 4 })];
  t.PackageRates = [r("recP1", { Tier: "basic", Sea: 350, Air: 8 }), r("recP2", { Tier: "business", Sea: 280, Air: 6 })];
  t.SpecialRates = [r("recSR1", { Name: "VIP Gold", Sea: 300, Air: 6 })];
  t.Settings = [r("recSet1", { UsdToGhs: 12.5, ShippingRatePerCbm: 350 })];
  t.Customers = [
    r("recC1", { Name: "Ama Mensah", Phone: "0241231234", Email: "ama@example.invalid", ShippingMark: "MOVEZZ-AM1234", Status: "active", CustomerPackage: "basic", PreferredWarehouse: "recW1", CreatedAt: iso("2025-01-10") }),
    r("recC2", { Name: "Kofi Boateng", Phone: "0245675678", Email: "kofi@example.invalid", ShippingMark: "MOVEZZ-KB5678", Status: "active", CustomerPackage: "premium", CreatedAt: iso("2025-02-11") }),
    r("recC3", { Name: "Yaw Asare", Phone: "0209990000", ShippingMark: "MOVEZZ-YA0000", Status: "inactive", CreatedAt: iso("2024-12-01") }),
  ];
  t.Containers = [
    r("recK1", { ContainerID: "PMX-CON-2026-001", Name: "MSC", Status: "Loading", DepartureDate: "2026-02-01", TrackingNumber: "MSCU1234567" }),
    r("recK2", { ContainerID: "PMX-CON-2026-002", Name: "Maersk", Status: "Arrived in Ghana", DepartureDate: "2026-01-05", ArrivalDate: "2026-02-20", TrackingNumber: "MAEU7654321" }),
  ];
  t.Items = [
    r("recI1", { ItemRef: "ITM-0001", Customer: ["recC1"], Container: ["recK1"], Order: ["recO1"], Status: "Arrived in Ghana", FreightType: "sea", Length: 100, Width: 100, Height: 100, DimensionUnit: "cm", Quantity: 1, PkgShippingRate: 350, PkgEstShipping: 350, Description: "Fabric rolls", DateReceived: "2026-01-12", CreatedAt: iso("2026-01-12") }),
    r("recI2", { ItemRef: "ITM-0002", Customer: ["recC1"], Container: ["recK1"], Order: ["recO1"], Status: "Arrived in Ghana", FreightType: "sea", Length: 100, Width: 100, Height: 100, DimensionUnit: "cm", Quantity: 1, PkgShippingRate: 350, PkgEstShipping: 350, Description: "Shoes", CreatedAt: iso("2026-01-13") }),
    r("recI3", { ItemRef: "ITM-0003", Customer: ["recC1"], Order: ["recO2"], Status: "Sorting", FreightType: "air", Weight: 12.5, PkgShippingRate: 8, PkgEstShipping: 100, Description: "Phones", CreatedAt: iso("2026-01-20") }),
    r("recI6", { ItemRef: "ITM-0006", Customer: ["recC1"], Order: ["recO5"], Status: "Ready for Pickup", FreightType: "sea", Length: 50, Width: 50, Height: 50, DimensionUnit: "cm", Quantity: 1, CartonNumber: "CTN-0001", CartonLength: 100, CartonWidth: 100, CartonHeight: 50, PkgEstShipping: 87.5, PreCartonPkgEstShipping: 100, PkgShippingRate: 350, Description: "Bags", CreatedAt: iso("2026-02-02") }),
    r("recI7", { ItemRef: "ITM-0007", Customer: ["recC1"], Order: ["recO5"], Status: "Ready for Pickup", FreightType: "sea", Length: 50, Width: 50, Height: 50, DimensionUnit: "cm", Quantity: 1, CartonNumber: "CTN-0001", CartonLength: 100, CartonWidth: 100, CartonHeight: 50, PkgEstShipping: 87.5, PreCartonPkgEstShipping: 100, PkgShippingRate: 350, Description: "Hats", CreatedAt: iso("2026-02-02") }),
    r("recI5", { ItemRef: "ITM-0005", Customer: ["recC1"], Order: ["recO4"], Status: "Completed", FreightType: "air", Weight: 6.25, PkgShippingRate: 8, PkgEstShipping: 50, Description: "Watch", CreatedAt: iso("2026-01-25") }),
    r("recI4", { ItemRef: "ITM-0004", Customer: ["recC2"], Order: ["recO3"], Status: "Arrived in Ghana", FreightType: "air", Weight: 10, PkgShippingRate: 8, PkgEstShipping: 80, Description: "Tablet", CreatedAt: iso("2026-01-28") }),
    r("recI17", { ItemRef: "ITM-0017", Customer: ["recC2"], Status: "Shipped to Ghana", FreightType: "sea", Length: 80, Width: 60, Height: 40, IsSpecialItem: true, specialRateName: "VIP Gold", SpecialShippingRate: 300, EstShippingPrice: 57.6, Description: "Special cargo", CreatedAt: iso("2026-02-05") }),
    r("recI30", { ItemRef: "ITM-0030", Customer: ["recC2"], Container: ["recK2"], Status: "Arrived in Ghana", FreightType: "sea", Length: 60, Width: 60, Height: 60, CartonNumber: "CTN-0003", CartonLength: 120, CartonWidth: 60, CartonHeight: 60, PkgEstShipping: 75, PreCartonPkgEstShipping: 80, Description: "Boxes A", Photos: [{ id: "attAAA111", url: "https://v5.airtableusercontent.com/v1/a.jpg", width: 800, height: 600 }, { id: "attBBB222", url: "https://res.cloudinary.com/demo/image/upload/b.jpg" }] }),
    r("recI31", { ItemRef: "ITM-0031", Customer: ["recC2"], Container: ["recK2"], Status: "Arrived in Ghana", FreightType: "sea", Length: 60, Width: 60, Height: 60, CartonNumber: "CTN-0003", CartonLength: 120, CartonWidth: 60, CartonHeight: 60, PkgEstShipping: 75, PreCartonPkgEstShipping: 80, Description: "Boxes B" }),
  ];
  t.Orders = [
    r("recO1", { OrderRef: "ORD-00001", Customer: ["recC1"], Items: ["recI1", "recI2"], InvoiceAmount: 8750, Status: "Paid", InvoiceDate: "2026-01-15", CreatedAt: iso("2026-01-15"), AmountPaid: 8750, BalanceDue: 0, KeepupSaleId: "KU-1000" }),
    r("recO2", { OrderRef: "ORD-00002", Customer: ["recC1"], Items: ["recI3"], InvoiceAmount: 1250, Status: "Partial", InvoiceDate: "2026-01-22", CreatedAt: iso("2026-01-22"), AmountPaid: 500, BalanceDue: 750, KeepupSaleId: "KU-1001" }),
    r("recO3", { OrderRef: "ORD-00003", Customer: ["recC2"], Items: ["recI4"], InvoiceAmount: 1000, Status: "Cancelled", InvoiceDate: "2026-01-30", CreatedAt: iso("2026-01-30") }),
    r("recO4", { OrderRef: "ORD-00004", Customer: ["recC1"], Items: ["recI5"], InvoiceAmount: 0, Discount: 50, Status: "Paid", InvoiceDate: "2026-01-26", CreatedAt: iso("2026-01-26") }),
    r("recO5", { OrderRef: "ORD-00005", Customer: ["recC1"], Items: ["recI6", "recI7"], InvoiceAmount: 2187.5, Status: "Pending", InvoiceDate: "2026-02-03", CreatedAt: iso("2026-02-03"), AmountPaid: 0, BalanceDue: 2187.5 }),
  ];
  t.VerifiedInvoices = [
    r("vi1", { OrderRecordID: "recO1", SubtotalUsd: 700, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 8750, Source: "keepup-export" }),
    r("vi2", { OrderRecordID: "recO2", SubtotalUsd: 100, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 1250, Source: "keepup-export" }),
    r("vi3", { OrderRecordID: "recO3", SubtotalUsd: 80, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 1000, CancelledAt: "2026-02-01T10:00:00Z", CancelReason: "Customer changed their mind", Source: "keepup-export" }),
    r("vi4", { OrderRecordID: "recO4", SubtotalUsd: 50, DiscountUsd: 50, DiscountReason: "Approved waiver by management", FxRate: 12.5, TotalGhs: 0, Source: "keepup-export" }),
    r("vi5", { OrderRecordID: "recO5", SubtotalUsd: 175, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 2187.5, Source: "keepup-export" }),
  ];
  t.VerifiedInvoiceLines = [
    r("vl1", { LineKey: "L-O1-1", OrderRecordID: "recO1", LineNo: 1, ItemRecordID: "recI1", Description: "Fabric rolls", UnitPriceUsd: 350, BillingBasis: "tier", PackageTier: "basic", RateUsd: 350 }),
    r("vl2", { LineKey: "L-O1-2", OrderRecordID: "recO1", LineNo: 2, ItemRecordID: "recI2", Description: "Shoes", UnitPriceUsd: 350, BillingBasis: "tier", PackageTier: "basic", RateUsd: 350 }),
    r("vl3", { LineKey: "L-O2-1", OrderRecordID: "recO2", LineNo: 1, ItemRecordID: "recI3", Description: "Phones", UnitPriceUsd: 100, BillingBasis: "tier", PackageTier: "basic", RateUsd: 8 }),
    r("vl4", { LineKey: "L-O3-1", OrderRecordID: "recO3", LineNo: 1, ItemRecordID: "recI4", Description: "Tablet", UnitPriceUsd: 80, BillingBasis: "tier", PackageTier: "enterprise", RateUsd: 8 }),
    r("vl5", { LineKey: "L-O4-1", OrderRecordID: "recO4", LineNo: 1, ItemRecordID: "recI5", Description: "Watch", UnitPriceUsd: 50, BillingBasis: "tier", PackageTier: "basic", RateUsd: 8 }),
    r("vl6", { LineKey: "L-O5-1", OrderRecordID: "recO5", LineNo: 1, CartonNumber: "CTN-0001", Description: "Carton CTN-0001", UnitPriceUsd: 175, BillingBasis: "tier", PackageTier: "basic", RateUsd: 350 }),
  ];
  t.VerifiedPayments = [
    r("vp1", { PaymentKey: "PAY-1", OrderRecordID: "recO1", AmountGhs: 8750, Currency: "GHS", Method: "bank_transfer", PaidAt: "2026-01-16T09:00:00Z", Status: "completed", KeepupReference: "KR-1" }),
    r("vp2", { PaymentKey: "PAY-2", OrderRecordID: "recO2", AmountGhs: 500, Currency: "GHS", Method: "momo", PaidAt: "2026-01-23T09:00:00Z", Status: "completed" }),
    r("vp3", { PaymentKey: "PAY-3", OrderRecordID: "recO3", AmountGhs: 400, Currency: "GHS", Method: "cash", PaidAt: "2026-01-31T09:00:00Z", Status: "voided", VoidedAt: "2026-01-31T15:00:00Z", VoidReason: "Entered on the wrong invoice" }),
  ];
  t.StatusHistory = [
    r("recH1", { RecordType: "Item", RecordID: "recI1", RecordRef: "ITM-0001", PreviousStatus: "Shipped to Ghana", NewStatus: "Arrived in Ghana", ChangedBy: "staff@example.invalid", ChangedByRole: "warehouse_staff", ChangedAt: "2026-02-21T09:00:00Z" }),
    r("recH2", { RecordType: "Order", RecordID: "recO1", RecordRef: "ORD-00001", PreviousStatus: "Pending", NewStatus: "Paid", ChangedBy: "admin@example.invalid", ChangedByRole: "super_admin", ChangedAt: "2026-01-16T09:05:00Z" }),
    r("recH3", { RecordType: "Container", RecordID: "recK2", RecordRef: "PMX-CON-2026-002", PreviousStatus: "Shipped to Ghana", NewStatus: "Arrived in Ghana", ChangedBy: "staff@example.invalid", ChangedByRole: "warehouse_staff", ChangedAt: "2026-02-20T12:00:00Z" }),
  ];
  t.ActivityLogs = [
    r("recA1", { Action: "CREATE_ITEM", UserEmail: "staff@example.invalid", UserRole: "warehouse_staff", Details: "Created ITM-0001", EntityType: "Item", EntityID: "recI1", Timestamp: "2026-01-12T08:30:00Z", IPAddress: "203.0.113.7" }),
    r("recA2", { Action: "LOGIN", UserEmail: "admin@example.invalid", UserRole: "super_admin", Details: "login", Timestamp: "2026-01-12T07:30:00Z" }),
  ];
  t.Users = [
    r("recU1", { FirebaseUID: "uid-admin-1", Email: "admin@example.invalid", Role: "super_admin", CreatedAt: iso("2024-01-01") }),
    r("recU2", { FirebaseUID: "uid-staff-1", Email: "staff@example.invalid", Role: "warehouse_staff", CreatedAt: iso("2024-02-01") }),
    r("recU3", { FirebaseUID: "uid-cust-1", Email: "ama@example.invalid", Role: "customer", CustomerRecord: ["recC1"], CreatedAt: iso("2025-01-11") }),
  ];
  return t;
}

/** @returns {{ format: string, source: any, tables: Record<string, any[]> }} */
export function buildCleanSnapshot() {
  const s = base("synthetic-clean"); s.tables = core();
  return s;
}

/** Every kind of problem the importer must catch, mixed with the valid core. */
/** @returns {{ format: string, source: any, tables: Record<string, any[]> }} */
export function buildMessySnapshot() {
  const s = base("synthetic-messy"); const t = (s.tables = core());
  t.Warehouses.push(r("recW2", { Name: "Closed Depot", IsActive: false }), r("recW3", { Address: "no name" }));
  t.Suppliers.push(r("recS2", { SupplierID: "SUP-0002", Name: "Bad Rating Ltd", Rating: 9 }), r("recS3", { SupplierID: "SUP-0003", Name: "Dup A" }), r("recS4", { SupplierID: "SUP-0003", Name: "Dup B" }));
  t.PackageRates.push(r("recP3", { Tier: "enterprise", Sea: 0, Air: 12 }), r("recP4", { Tier: "platinum", Sea: 1, Air: 1 }));
  t.SpecialRates.push(r("recSR2", { Name: "Nothing", Sea: 0, Air: 0 }), r("recSR3", { Name: "Air only", Sea: 0, Air: 5 }));
  t.Customers.push(
    r("recC4", { Name: "Efua Owusu", Phone: "0551110001", ShippingMark: "MOVEZZ-EO0001", Status: "active" }),
    r("recC5", { Name: "Efua Owusu", Phone: "0551110001", ShippingMark: "MOVEZZ-EO0002", Status: "active" }),
    r("recC6", { Phone: "0551110002", ShippingMark: "MOVEZZ-XX0002" }),
    r("recC7", { Name: "Bad Mark", ShippingMark: "BAD MARK 1", Phone: "0551110003" }),
    r("recC8", { Name: "Lost Warehouse", ShippingMark: "MOVEZZ-LW0004", Phone: "0551110004", PreferredWarehouse: "recWmissing" }),
    r("recC9", { Name: "Odd Status", ShippingMark: "MOVEZZ-OS0005", Phone: "0551110005", Status: "suspended" }),
    r("recC10", { Name: "Old Mark", ShippingMark: "OLD-MARK-77", Phone: "0551110006" }),
    r("recC11", { Name: "Extra Fields", ShippingMark: "MOVEZZ-EF0007", Phone: "0551110007", VIPLevel: "gold", Mood: "good" }),
    r("recC12", { Name: "Has Login", ShippingMark: "MOVEZZ-HL0008", Phone: "0551110008", FirebaseUID: "uid-should-not-be-carried", ExchangeRate: 14 }),
    r("recC13", { Name: "Adwoa Pakk", ShippingMark: "PAKKMAXX-ADWOA-9012", Phone: "0551110009", Email: "not-an-email" }),
    r("recC14", { Name: "Adwoa Pakk Two", ShippingMark: "PAKKMAXX-ADWOA-9013", Phone: "0551110010", Email: "adwoa2@example.invalid" }),
  );
  t.Users.push(r("recU4", { FirebaseUID: "uid-cust-9", Email: "ghost@example.invalid", Role: "customer", CustomerRecord: ["recCmissing"] }), r("recU5", { FirebaseUID: "uid-cust-1b", Email: "ama@example.invalid", Role: "customer", CustomerRecord: ["recC1"] }));
  t.Containers.push(
    r("recK3", { ContainerID: "PMX-CON-2026-003", Name: "A" }), r("recK4", { ContainerID: "PMX-CON-2026-003", Name: "B" }),
    r("recK5", { ContainerID: "PMX-CON-2026-005", Status: "Lost" }), r("recK6", { ContainerID: "PMX-CON-2026-006", DepartureDate: "2026-02-31" }));
  t.Items.push(
    r("recI8", { ItemRef: "ITM-0008", Customer: ["recC2"], Order: ["recO6"], Status: "Sorting", FreightType: "air", Weight: 5, PkgEstShipping: 40, Description: "Behind a quarantined order" }),
    r("recI9", { ItemRef: "ITM-0009", Customer: ["recC1"], Order: ["recO7"], Status: "Sorting", FreightType: "air", Weight: 5, PkgEstShipping: 40 }),
    r("recI10", { ItemRef: "ITM-0010", Customer: ["recC1"], Order: ["recO8"], Status: "Sorting", FreightType: "air", Weight: 7.5, PkgEstShipping: 60 }),
    r("recI11", { ItemRef: "ITM-0011", Customer: ["recC2"], Order: ["recO10"], Status: "Sorting", FreightType: "air", Weight: 5, PkgEstShipping: 40 }),
    r("recI12", { ItemRef: "ITM-0012", Customer: ["recC1"], Order: ["recO11"], Status: "Sorting", FreightType: "air", Weight: 2.5, PkgEstShipping: 20 }),
    r("recI13", { ItemRef: "ITM-0013", Customer: ["recC2"], Order: ["recO9"], Status: "Sorting", FreightType: "air", Weight: 12.5, PkgEstShipping: 100 }),
    r("recI14", { ItemRef: "ITM-0014", Customer: ["recCmissing"], Status: "Sorting" }),
    r("recI15", { ItemRef: "ITM-0015", Status: "Sorting" }),
    r("recI16", { ItemRef: "ITM-0016", Customer: ["recC1"], Status: "Lost in space" }),
    r("recI18", { ItemRef: "ITM-0018", Customer: ["recC1"], Weight: -3, FreightType: "air" }),
    r("recI19", { ItemRef: "ITM-0019", Customer: ["recC1"], FreightType: "air", CartonNumber: "CTN-0002", CartonLength: 10, CartonWidth: 10, CartonHeight: 10 }),
    r("recI20", { ItemRef: "ITM-0900", Customer: ["recC1"] }), r("recI21", { ItemRef: "ITM-0900", Customer: ["recC1"] }),
    r("recI22", { ItemRef: "ITM-0022", Customer: ["recC1"], DateReceived: "yesterday" }),
    r("recI23", { ItemRef: "ITM-0023", Customer: ["recC1"], Container: ["recKmissing"] }),
    r("recI24", { ItemRef: "ITM-0024", Customer: ["recC4"] }),
    r("recI25", { ItemRef: "ITM-0025", Customer: ["recC1"], Photos: [{ id: "attCCC333", url: "https://v5.airtableusercontent.com/c.jpg" }, { id: "attDDD444", url: "http://insecure.example.invalid/d.jpg" }, { id: "attCCC333", url: "https://v5.airtableusercontent.com/dup.jpg" }], Mystery: "x" }),
    r("recI26", { ItemRef: "ITM-0026", Customer: ["recC1"], EstPrice: "12.345" }),
    r("recI27", { ItemRef: "ITM-0027", Customer: ["recC1"], Notes: "bad\u0000byte" }),
    r("recI28", { ItemRef: "ITM-0028", Customer: ["recC1"], ["__proto__"]: { admin: true } }),
  );
  // JSON.parse creates an OWN "__proto__" key, exactly like a hostile file would; build that shape explicitly
  t.Items.find((x) => x.id === "recI28").fields = JSON.parse('{"ItemRef":"ITM-0028","Customer":["recC1"],"__proto__":{"isAdmin":true}}');
  t.Orders.push(
    r("recO6", { OrderRef: "ORD-00006", Customer: ["recC2"], Items: ["recI8"], InvoiceAmount: 40, Status: "Pending", InvoiceDate: "2026-02-10" }),
    r("recO7", { OrderRef: "ORD-00007", Customer: ["recC1"], Items: ["recI9"], InvoiceAmount: 40, Status: "Pending", InvoiceDate: "2026-02-10" }),
    r("recO8", { OrderRef: "ORD-00008", Customer: ["recC1"], Items: ["recI10"], InvoiceAmount: 750, Status: "Cancelled", InvoiceDate: "2026-02-11" }),
    r("recO9", { OrderRef: "ORD-00009", Customer: ["recC2"], Items: ["recI13"], InvoiceAmount: 1250, Status: "Paid", InvoiceDate: "2026-02-12" }),
    r("recO10", { OrderRef: "ORD-00010", Customer: ["recC2"], Items: ["recI11"], InvoiceAmount: 500, Status: "Pending", InvoiceDate: "2026-02-13" }),
    r("recO11", { OrderRef: "ORD-00011", Customer: ["recC1"], Items: ["recI12"], InvoiceAmount: 250, Status: "Paid", InvoiceDate: "2026-02-14", AmountPaid: 100, BalanceDue: 0 }),
    r("recO12", { OrderRef: "ORD-00012", Customer: ["recC1"], Items: [], Status: "Refunded", InvoiceDate: "2026-02-14" }),
    r("recO13", { OrderRef: "ORD-00013", Customer: ["recC1"], Items: [], Status: "Pending", InvoiceDate: "14/02/2026" }),
  );
  t.VerifiedInvoices.push(
    r("vi7", { OrderRecordID: "recO7", SubtotalUsd: 40, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 999 }),
    r("vi8", { OrderRecordID: "recO8", SubtotalUsd: 60, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 750, CancelledAt: "2026-02-15T10:00:00Z" }),
    r("vi9", { OrderRecordID: "recO9", SubtotalUsd: 100, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 1250 }),
    r("vi10", { OrderRecordID: "recO10", SubtotalUsd: 40, DiscountUsd: 0, FxRate: 12, TotalGhs: 500, FxEstimated: true, Note: "Rate estimated from the nearest Keepup invoice day" }),
    r("vi11", { OrderRecordID: "recO11", SubtotalUsd: 20, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 250 }),
    r("vi99", { OrderRecordID: "recOnone", SubtotalUsd: 1, DiscountUsd: 0, FxRate: 12.5, TotalGhs: 12.5 }));
  t.VerifiedPayments.push(
    r("vp4", { PaymentKey: "PAY-4", OrderRecordID: "recO8", AmountGhs: 750, Currency: "GHS", PaidAt: "2026-02-12T09:00:00Z", Status: "completed" }),
    r("vp5", { PaymentKey: "PAY-5", OrderRecordID: "recO9", AmountGhs: 1000, Currency: "GHS", PaidAt: "2026-02-12T09:00:00Z", Status: "completed" }),
    r("vp6", { PaymentKey: "PAY-6", OrderRecordID: "recO9", AmountGhs: 500, Currency: "GHS", PaidAt: "2026-02-13T09:00:00Z", Status: "completed" }),
    r("vp7", { PaymentKey: "PAY-7", OrderRecordID: "recO2", AmountGhs: 10, Currency: "USD", PaidAt: "2026-02-13T09:00:00Z", Status: "completed" }),
    r("vp8", { PaymentKey: "PAY-8", OrderRecordID: "recO2", AmountGhs: "ten", Currency: "GHS", PaidAt: "2026-02-13T09:00:00Z", Status: "completed" }),
    r("vp9", { PaymentKey: "PAY-9", OrderRecordID: "recO2", AmountGhs: 10, Currency: "GHS", PaidAt: "2026-02-13T09:00:00Z", Status: "pending" }),
    r("vp10", { PaymentKey: "PAY-10", OrderRecordID: "recOnone", AmountGhs: 10, Currency: "GHS", PaidAt: "2026-02-13T09:00:00Z", Status: "completed" }));
  t.StatusHistory.push(
    r("recH4", { RecordType: "Item", RecordID: "recImissing", NewStatus: "Sorting", ChangedAt: "2026-02-01T00:00:00Z" }),
    r("recH5", { RecordType: "Item", RecordID: "recI1", NewStatus: "Sorting", ChangedAt: "not a date" }),
    r("recH6", { RecordType: "Spaceship", RecordID: "recI1", NewStatus: "Sorting", ChangedAt: "2026-02-01T00:00:00Z" }),
    r("recH7", { RecordType: "Item", RecordID: "recI8", NewStatus: "Sorting", ChangedAt: "2026-02-01T00:00:00Z" }));
  t.ActivityLogs.push(
    r("recA3", { Action: "UPDATE_ITEM", UserEmail: "staff@example.invalid", Details: "bad ip", Timestamp: "2026-01-12T08:31:00Z", IPAddress: "not-an-ip" }),
    r("recA4", { Action: "VIEW", Timestamp: "garbage" }));
  t.PendingRegistrations = [r("recR1", { Name: "Waiting Person", Email: "wait@example.invalid", Status: "pending" })];
  t.Experimental = [r("recX1", { Anything: "goes" })];
  t.Orders.push(r("recODUP", { OrderRef: "ORD-DUP1", Customer: ["recC1"], Items: [] }), r("recODUP", { OrderRef: "ORD-DUP2", Customer: ["recC1"], Items: [] }));                // a second record with an existing source id
  return s;
}
