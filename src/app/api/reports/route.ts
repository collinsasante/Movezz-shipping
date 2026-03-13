// GET /api/reports — revenue aggregates for admin reports page
import { NextRequest } from "next/server";
import { requireAuth, serverErrorResponse } from "@/lib/auth";
import { TABLES } from "@/lib/airtable";
import Airtable, { FieldSet, Record as AirtableRecord } from "airtable";

function getBase() {
  const apiKey = process.env.AIRTABLE_API_KEY!;
  const baseId = process.env.AIRTABLE_BASE_ID!;
  Airtable.configure({ apiKey });
  return new Airtable().base(baseId);
}

async function getAllRecords(tableName: string): Promise<AirtableRecord<FieldSet>[]> {
  const base = getBase();
  const records: AirtableRecord<FieldSet>[] = [];
  await base(tableName)
    .select({ pageSize: 100 })
    .eachPage((page, next) => { records.push(...page); next(); });
  return records;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const fromDate = fromParam ? new Date(fromParam) : null;
    const toDate = toParam ? (() => { const d = new Date(toParam); d.setHours(23, 59, 59, 999); return d; })() : null;

    const [orderRecords, customerRecords, itemRecords] = await Promise.all([
      getAllRecords(TABLES.ORDERS),
      getAllRecords(TABLES.CUSTOMERS),
      getAllRecords(TABLES.ITEMS),
    ]);

    // Filter orders by date range when params provided
    const filteredOrderRecords = (fromDate || toDate) ? orderRecords.filter((r) => {
      const dateStr = (r.fields["InvoiceDate"] as string) ?? (r.fields["CreatedAt"] as string);
      if (!dateStr) return false;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    }) : orderRecords;

    const now = new Date();
    const thisYear = now.getFullYear();
    const thisMonth = now.getMonth(); // 0-indexed

    // Revenue totals (use filtered orders)
    const paidOrderRecords = filteredOrderRecords.filter((r) => r.fields["Status"] === "Paid");

    const totalRevenue = paidOrderRecords.reduce(
      (sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0),
      0
    );

    const pendingRevenue = filteredOrderRecords
      .filter((r) => r.fields["Status"] === "Pending")
      .reduce((sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0), 0);

    const totalOrders = filteredOrderRecords.length;
    const paidOrders = paidOrderRecords.length;

    // Revenue this month / this year
    const revenueThisMonth = paidOrderRecords.reduce((sum, r) => {
      const dateStr = (r.fields["InvoiceDate"] as string) ?? (r.fields["CreatedAt"] as string);
      if (!dateStr) return sum;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return sum;
      if (d.getFullYear() === thisYear && d.getMonth() === thisMonth) {
        return sum + ((r.fields["InvoiceAmount"] as number) ?? 0);
      }
      return sum;
    }, 0);

    const revenueThisYear = paidOrderRecords.reduce((sum, r) => {
      const dateStr = (r.fields["InvoiceDate"] as string) ?? (r.fields["CreatedAt"] as string);
      if (!dateStr) return sum;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return sum;
      if (d.getFullYear() === thisYear) {
        return sum + ((r.fields["InvoiceAmount"] as number) ?? 0);
      }
      return sum;
    }, 0);

    const avgOrderValue = paidOrders > 0 ? totalRevenue / paidOrders : 0;

    // Total shipments
    const totalShipments = itemRecords.length;

    // Monthly revenue (last 12 months, Paid orders)
    const monthlyMap: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthlyMap[key] = 0;
    }
    for (const r of orderRecords) {
      if (r.fields["Status"] !== "Paid") continue;
      const dateStr = (r.fields["InvoiceDate"] as string) ?? (r.fields["CreatedAt"] as string);
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (key in monthlyMap) monthlyMap[key] += (r.fields["InvoiceAmount"] as number) ?? 0;
    }
    const monthlyRevenue = Object.entries(monthlyMap).map(([month, revenue]) => ({
      month,
      revenue,
    }));

    // Monthly shipments (last 12 months, by DateReceived)
    const monthlyShipmentsMap: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthlyShipmentsMap[key] = 0;
    }
    for (const r of itemRecords) {
      const dateStr = r.fields["DateReceived"] as string;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (key in monthlyShipmentsMap) monthlyShipmentsMap[key] += 1;
    }
    const monthlyShipments = Object.entries(monthlyShipmentsMap).map(([month, count]) => ({
      month,
      count,
    }));

    // Top customers by total paid revenue
    const customerRevMap: Record<string, { name: string; revenue: number; orders: number }> = {};
    for (const r of filteredOrderRecords) {
      if (r.fields["Status"] !== "Paid") continue;
      const custIds = (r.fields["Customer"] as string[]) ?? [];
      const custId = custIds[0] ?? "";
      if (!custId) continue;
      if (!customerRevMap[custId]) {
        const custRecord = customerRecords.find((c) => c.id === custId);
        customerRevMap[custId] = {
          name: (custRecord?.fields["Name"] as string) ?? "Unknown",
          revenue: 0,
          orders: 0,
        };
      }
      customerRevMap[custId].revenue += (r.fields["InvoiceAmount"] as number) ?? 0;
      customerRevMap[custId].orders += 1;
    }
    const topCustomers = Object.entries(customerRevMap)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Customer analytics — all customers, outstanding balance = Pending + Partial orders
    const allCustomerOrders: Record<string, {
      name: string;
      totalOrders: number;
      totalRevenue: number;
      outstandingBalance: number;
    }> = {};

    // Seed with all customers so every customer appears
    for (const c of customerRecords) {
      allCustomerOrders[c.id] = {
        name: (c.fields["Name"] as string) ?? "Unknown",
        totalOrders: 0,
        totalRevenue: 0,
        outstandingBalance: 0,
      };
    }

    for (const r of filteredOrderRecords) {
      const custIds = (r.fields["Customer"] as string[]) ?? [];
      const custId = custIds[0] ?? "";
      if (!custId) continue;
      if (!allCustomerOrders[custId]) {
        const custRecord = customerRecords.find((c) => c.id === custId);
        allCustomerOrders[custId] = {
          name: (custRecord?.fields["Name"] as string) ?? "Unknown",
          totalOrders: 0,
          totalRevenue: 0,
          outstandingBalance: 0,
        };
      }
      const status = r.fields["Status"] as string;
      const amount = (r.fields["InvoiceAmount"] as number) ?? 0;
      allCustomerOrders[custId].totalOrders += 1;
      if (status === "Paid") {
        allCustomerOrders[custId].totalRevenue += amount;
      }
      if (status === "Pending" || status === "Partial") {
        allCustomerOrders[custId].outstandingBalance += amount;
      }
    }

    const customerAnalytics = Object.entries(allCustomerOrders)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    // Outstanding payments — Pending + Partial orders sorted by invoiceDate asc
    const outstandingPayments = filteredOrderRecords
      .filter((r) => {
        const status = r.fields["Status"] as string;
        return status === "Pending" || status === "Partial";
      })
      .map((r) => {
        const custIds = (r.fields["Customer"] as string[]) ?? [];
        const custId = custIds[0] ?? "";
        let customerName = (r.fields["CustomerName"] as string) ?? "";
        if (!customerName && custId) {
          const custRecord = customerRecords.find((c) => c.id === custId);
          customerName = (custRecord?.fields["Name"] as string) ?? "Unknown";
        }
        return {
          id: r.id,
          orderRef: (r.fields["OrderRef"] as string) ?? r.id,
          customerName,
          invoiceAmount: (r.fields["InvoiceAmount"] as number) ?? 0,
          invoiceDate: (r.fields["InvoiceDate"] as string) ?? "",
          status: (r.fields["Status"] as string) ?? "",
        };
      })
      .sort((a, b) => {
        if (!a.invoiceDate) return 1;
        if (!b.invoiceDate) return -1;
        return new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime();
      });

    return Response.json({
      success: true,
      data: {
        totalRevenue,
        pendingRevenue,
        totalOrders,
        paidOrders,
        monthlyRevenue,
        topCustomers,
        revenueThisMonth,
        revenueThisYear,
        avgOrderValue,
        totalShipments,
        monthlyShipments,
        customerAnalytics,
        outstandingPayments,
      },
    });
  } catch {
    return serverErrorResponse("Failed to fetch reports");
  }
}
