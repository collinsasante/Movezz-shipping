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
    const [orderRecords, customerRecords] = await Promise.all([
      getAllRecords(TABLES.ORDERS),
      getAllRecords(TABLES.CUSTOMERS),
    ]);

    // Revenue totals
    const totalRevenue = orderRecords
      .filter((r) => r.fields["Status"] === "Paid")
      .reduce((sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0), 0);

    const pendingRevenue = orderRecords
      .filter((r) => r.fields["Status"] === "Pending")
      .reduce((sum, r) => sum + ((r.fields["InvoiceAmount"] as number) ?? 0), 0);

    const totalOrders = orderRecords.length;
    const paidOrders = orderRecords.filter((r) => r.fields["Status"] === "Paid").length;

    // Monthly revenue (last 12 months, Paid orders)
    const monthlyMap: Record<string, number> = {};
    const now = new Date();
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

    // Top customers by total paid revenue
    const customerRevMap: Record<string, { name: string; revenue: number; orders: number }> = {};
    for (const r of orderRecords) {
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

    return Response.json({
      success: true,
      data: {
        totalRevenue,
        pendingRevenue,
        totalOrders,
        paidOrders,
        monthlyRevenue,
        topCustomers,
      },
    });
  } catch (err) {
    console.error("[GET /reports]", err);
    return serverErrorResponse("Failed to fetch reports");
  }
}
