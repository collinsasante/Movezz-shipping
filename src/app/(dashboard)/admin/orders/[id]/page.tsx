"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Order, Item } from "@/types";
import {
  ArrowLeft,
  Package,
  ExternalLink,
  DollarSign,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import axios from "axios";
import { useToast } from "@/components/ui/toast";

interface OrderDetail extends Order {
  items?: Item[];
  keepupTotalAmount?: number | null;
  keepupAmountPaid?: number | null;
  keepupBalanceDue?: number | null;
}

function getCbm(item: Item): number {
  if (!item.length || !item.width || !item.height) return 0;
  const factor = item.dimensionUnit === "inches" ? 16.387064 : 1;
  const qty = item.quantity ?? 1;
  return (item.length * item.width * item.height * factor * qty) / 1_000_000;
}

export default function AdminOrderDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { success, error } = useToast();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [cancelingInvoice, setCancelingInvoice] = useState(false);
  const [confirmCancelInvoice, setConfirmCancelInvoice] = useState(false);

  // Extra info
  const [customerPhone, setCustomerPhone] = useState<string>("");
  const [customerPackage, setCustomerPackage] = useState<string>("basic");

  // Keepup payment data — persisted separately so values survive re-fetches where Keepup returns null
  const [keepupPaid, setKeepupPaid] = useState<number | null>(null);
  const [keepupBalance, setKeepupBalance] = useState<number | null>(null);
  const [keepupTotal, setKeepupTotal] = useState<number | null>(null);

  // Record Payment modal
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/orders/${id}`);
      const o: OrderDetail = res.data.data;
      setOrder(o);
      // Only update keepup payment amounts if the API returned real values (Keepup didn't fail)
      if (o.keepupAmountPaid != null || o.keepupTotalAmount != null) {
        setKeepupPaid(o.keepupAmountPaid ?? null);
        setKeepupBalance(o.keepupBalanceDue ?? null);
        setKeepupTotal(o.keepupTotalAmount ?? null);
      }
      // Fetch customer phone + package tier
      if (o.customerId) {
        axios.get(`/api/customers/${o.customerId}`).then((cRes) => {
          const c = cRes.data.data;
          setCustomerPhone(c?.phone ?? "");
          setCustomerPackage(c?.package ?? "standard");
        }).catch(() => {});
      }
    } catch {
      error("Failed to load invoice");
    } finally {
      setLoading(false);
    }
  }, [id, error]);

  useEffect(() => { load(); }, [load]);

  const handleCreateInvoice = async () => {
    if (!order) return;
    setCreatingInvoice(true);
    try {
      // Split invoice amount proportionally by CBM (or equally if no dimensions)
      const items = order.items ?? [];
      const cbms = items.map((item) => getCbm(item));
      const totalCbmForInvoice = cbms.reduce((s, c) => s + c, 0);
      const priceMap: Record<string, number> = {};
      let running = 0;
      items.forEach((item, i) => {
        const proportion = totalCbmForInvoice > 0 ? cbms[i] / totalCbmForInvoice : 1 / items.length;
        if (i < items.length - 1) {
          const p = Math.round(order.invoiceAmount * proportion * 100) / 100;
          priceMap[item.id] = p;
          running += p;
        } else {
          priceMap[item.id] = Math.round((order.invoiceAmount - running) * 100) / 100;
        }
      });

      const itemPriceMap = Object.keys(priceMap).length > 0 ? priceMap : undefined;
      await axios.post(`/api/orders/${id}/create-invoice`, { itemPriceMap });
      success("Invoice created in Keepup");
      load();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Failed to create invoice" : "Failed to create invoice";
      error("Error", msg);
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`/api/orders/${id}`);
      success("Invoice deleted");
      router.push("/admin/orders");
    } catch {
      error("Failed to delete invoice");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSavePayment = async () => {
    const amount = parseFloat(paymentAmount);
    if (!amount || amount <= 0) {
      error("Invalid amount", "Please enter a valid payment amount");
      return;
    }
    setSavingPayment(true);
    try {
      await axios.patch(`/api/orders/${id}`, { paymentAmount: amount });
      success("Payment recorded");
      setPaymentModalOpen(false);
      setPaymentAmount("");
      // Optimistically update payment figures before re-fetch
      setKeepupPaid((prev) => (prev ?? 0) + amount);
      setKeepupBalance((prev) => Math.max(0, (prev ?? (order?.invoiceAmount ?? 0)) - amount));
      load();
    } catch {
      error("Failed to record payment");
    } finally {
      setSavingPayment(false);
    }
  };

  const handleCancelInvoice = async () => {
    setCancelingInvoice(true);
    try {
      await axios.delete(`/api/orders/${id}/create-invoice`);
      await axios.delete(`/api/orders/${id}`);
      success("Invoice cancelled and deleted");
      router.push("/admin/orders");
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error ?? "Failed to cancel invoice" : "Failed to cancel invoice";
      error("Error", msg);
      setCancelingInvoice(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-400">Invoice not found</p>
      </div>
    );
  }

  const totalCbm = order.items?.reduce((sum, item) => sum + getCbm(item), 0) ?? 0;

  // Per-item prices: proportional split of invoice total by CBM
  const itemPrices = (() => {
    const items = order.items ?? [];
    if (items.length === 0) return new Map<string, number>();
    const cbms = items.map((item) => getCbm(item));
    const total = cbms.reduce((s, c) => s + c, 0);
    const prices = new Map<string, number>();
    let running = 0;
    items.forEach((item, i) => {
      const proportion = total > 0 ? cbms[i] / total : 1 / items.length;
      if (i < items.length - 1) {
        const p = Math.round(order.invoiceAmount * proportion * 100) / 100;
        prices.set(item.id, p);
        running += p;
      } else {
        prices.set(item.id, Math.round((order.invoiceAmount - running) * 100) / 100);
      }
    });
    return prices;
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2 shrink-0">
        <button
          onClick={() => router.push("/admin/orders")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
          Invoices
        </button>
        <span className="text-gray-300 hidden sm:inline">|</span>
        <span className="font-mono font-bold text-gray-800 text-sm truncate max-w-[120px] sm:max-w-none">{order.orderRef}</span>
        <StatusBadge status={order.status} />

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {order.status !== "Paid" && (
            <Button size="sm" variant="outline" onClick={handleCreateInvoice} loading={creatingInvoice}>
              <ExternalLink className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{order.keepupSaleId ? "Update Invoice" : "Create Invoice"}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: read-only invoice details */}
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-white rounded-2xl border border-gray-100 p-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-5">Invoice Details</h3>

              <div className="space-y-4">
                {/* Customer */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Customer</label>
                  <button
                    onClick={() => router.push(`/admin/customers/${order.customerId}`)}
                    className="text-sm font-semibold text-brand-600 hover:underline"
                  >
                    {order.customerName ?? "—"}
                  </button>
                </div>

                {customerPhone && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Customer Phone</label>
                    <p className="text-sm text-gray-900">{customerPhone}</p>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Invoice Date</label>
                  <p className="text-sm text-gray-900">{order.invoiceDate ? formatDate(order.invoiceDate) : "—"}</p>
                </div>

                {order.notes && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Notes</label>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{order.notes}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Items */}
            <div className="bg-white rounded-2xl border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                  Items ({order.itemIds?.length ?? 0})
                </h3>
                {totalCbm > 0 && (
                  <span className="text-xs font-semibold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full">
                    Total CBM: {totalCbm.toFixed(4)} m³
                  </span>
                )}
              </div>

              {order.items && order.items.length > 0 ? (
                <div className="divide-y divide-gray-50">
                  {order.items.map((item) => {
                    const cbm = getCbm(item);
                    return (
                      <button
                        key={item.id}
                        onClick={() => router.push(`/admin/items/${item.id}`)}
                        className="w-full flex items-start gap-3 py-3 hover:bg-gray-50 transition-colors text-left -mx-1 px-1 rounded-lg"
                      >
                        <Package className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{item.description || item.itemRef}</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                            <span className="text-xs text-gray-500">{item.itemRef}</span>
                            {item.trackingNumber && (
                              <span className="text-xs text-gray-500">TRK: {item.trackingNumber}</span>
                            )}
                            {cbm > 0 && (
                              <span className="text-xs font-medium text-brand-600">{cbm.toFixed(4)} m³</span>
                            )}
                            {item.weight && !cbm && (
                              <span className="text-xs text-gray-500">{item.weight} kg</span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <StatusBadge status={item.status} />
                          {itemPrices.get(item.id) != null && (
                            <span className="text-xs font-semibold text-brand-700">{formatCurrency(itemPrices.get(item.id)!)}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No items linked</p>
              )}
            </div>
          </div>

          {/* Right: summary */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-400">Invoice Ref</span>
                  <span className="text-sm font-mono font-bold text-gray-800">{order.orderRef}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-400">Status</span>
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex justify-between items-center border-t border-gray-50 pt-3">
                  <span className="text-xs text-gray-400">Invoice Total</span>
                  <span className="text-base font-bold text-gray-900">{formatCurrency(order.invoiceAmount)}</span>
                </div>
                {order.createdBy && (
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">Created by</span>
                    <span className="text-xs text-gray-700">{order.createdBy}</span>
                  </div>
                )}
                {order.keepupSaleId && (
                  <div className="border-t border-gray-50 pt-3 space-y-1.5">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Payment Info</p>
                    {keepupTotal != null && (
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-gray-400">Invoice Total</span>
                        <span className="font-semibold text-gray-800">{formatCurrency(keepupTotal)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-gray-400">Amount Paid</span>
                      <span className="font-semibold text-green-700">{formatCurrency(keepupPaid ?? 0)}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs border-t border-gray-100 pt-1.5 mt-1">
                      <span className="text-gray-500 font-medium">Balance Due</span>
                      <span className={`font-bold ${(keepupBalance ?? 0) <= 0 ? "text-green-700" : "text-orange-600"}`}>
                        {formatCurrency(Math.max(0, keepupBalance ?? (order.invoiceAmount - (keepupPaid ?? 0))))}
                      </span>
                    </div>
                  </div>
                )}
                {order.status === "Partial" && (
                  <p className="text-xs text-orange-600 bg-orange-50 rounded-lg p-2">
                    Partial payment received. Check Keepup for payment details.
                  </p>
                )}
                {order.status === "Pending" && (
                  <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2">
                    Awaiting payment from customer.
                  </p>
                )}
                {order.status === "Paid" && (
                  <p className="text-xs text-green-700 bg-green-50 rounded-lg p-2">
                    Payment confirmed ✓
                  </p>
                )}
                <button
                  onClick={() => { setPaymentAmount(""); setPaymentModalOpen(true); }}
                  className="inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs w-full mt-1"
                >
                  <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                  Record Payment
                </button>
              </div>
            </div>

            {order.keepupSaleId && (
              <div className="bg-white rounded-2xl border border-gray-100 p-5">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Keepup</h3>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">Sale ID</span>
                    <span className="text-xs font-mono text-gray-600">{order.keepupSaleId}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {order.keepupLink && (
                      <a
                        href={order.keepupLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs gap-1.5"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open Invoice
                      </a>
                    )}
                    {confirmCancelInvoice ? (
                      <>
                        <span className="text-xs text-red-600 self-center">Cancel invoice?</span>
                        <button
                          className="inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border bg-background hover:text-accent-foreground h-8 rounded-md px-3 text-xs border-red-300 text-red-600 hover:bg-red-50"
                          disabled={cancelingInvoice}
                          onClick={handleCancelInvoice}
                        >
                          {cancelingInvoice ? "Cancelling..." : "Confirm"}
                        </button>
                        <button
                          className="inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs"
                          onClick={() => setConfirmCancelInvoice(false)}
                        >
                          Back
                        </button>
                      </>
                    ) : (
                      <button
                        className="inline-flex items-center justify-center whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border bg-background hover:text-accent-foreground h-8 rounded-md px-3 text-xs border-red-300 text-red-600 hover:bg-red-50"
                        onClick={() => setConfirmCancelInvoice(true)}
                      >
                        Cancel Invoice
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Record Payment Modal */}
      <Dialog open={paymentModalOpen} onOpenChange={setPaymentModalOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-brand-600" />
              Record Payment
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <label className="block text-xs font-medium text-gray-500 mb-1">Payment Amount (USD)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              className="h-10 w-full px-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSavePayment} loading={savingPayment}>Save Payment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
