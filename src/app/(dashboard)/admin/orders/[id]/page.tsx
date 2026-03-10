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
  Trash2,
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

  // Extra info
  const [customerPhone, setCustomerPhone] = useState<string>("");

  // Record Payment modal
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/orders/${id}`);
      const o: OrderDetail = res.data.data;
      setOrder(o);
      // Fetch customer phone
      if (o.customerId) {
        axios.get(`/api/customers/${o.customerId}`).then((cRes) => {
          setCustomerPhone(cRes.data.data?.phone ?? "");
        }).catch(() => {});
      }
    } catch {
      error("Failed to load order");
    } finally {
      setLoading(false);
    }
  }, [id, error]);

  useEffect(() => { load(); }, [load]);

  const handleCreateInvoice = async () => {
    if (!order) return;
    setCreatingInvoice(true);
    try {
      await axios.post(`/api/orders/${id}/create-invoice`);
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
      success("Order deleted");
      router.push("/admin/orders");
    } catch {
      error("Failed to delete order");
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
      load();
    } catch {
      error("Failed to record payment");
    } finally {
      setSavingPayment(false);
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
        <p className="text-gray-400">Order not found</p>
      </div>
    );
  }

  const totalCbm = order.items?.reduce((sum, item) => sum + getCbm(item), 0) ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 shrink-0">
        <button
          onClick={() => router.push("/admin/orders")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Invoices
        </button>
        <span className="text-gray-300">|</span>
        <span className="font-mono font-bold text-gray-800">{order.orderRef}</span>
        <StatusBadge status={order.status} />

        <div className="ml-auto flex items-center gap-2">
          {order.keepupSaleId ? (
            order.keepupLink && (
              <a
                href={order.keepupLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-800 border border-brand-200 rounded-lg px-3 py-1.5 hover:bg-brand-50 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on Keepup
              </a>
            )
          ) : (
            <Button size="sm" variant="outline" onClick={handleCreateInvoice} loading={creatingInvoice}>
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              Create Invoice
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { setPaymentAmount(""); setPaymentModalOpen(true); }}>
            <DollarSign className="h-3.5 w-3.5 mr-1" />
            Record Payment
          </Button>
          {confirmDelete ? (
            <>
              <span className="text-xs text-red-600">Delete?</span>
              <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" loading={deleting} onClick={handleDelete}>Confirm</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
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

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Invoice Amount (GHS)</label>
                    <p className="text-sm font-semibold text-gray-900">{formatCurrency(order.invoiceAmount)}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Invoice Date</label>
                    <p className="text-sm text-gray-900">{order.invoiceDate ? formatDate(order.invoiceDate) : "—"}</p>
                  </div>
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
                        <StatusBadge status={item.status} />
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
                  <span className="text-xs text-gray-400">Order Ref</span>
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
                {customerPhone && (
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">Customer Phone</span>
                    <span className="text-xs text-gray-700">{customerPhone}</span>
                  </div>
                )}
                {order.keepupSaleId && (
                  <div className="border-t border-gray-50 pt-3 space-y-1.5">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Payment Info</p>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-gray-400">Amount Paid</span>
                      <span className="font-semibold text-green-700">{formatCurrency(order.keepupAmountPaid ?? 0)}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-gray-500 font-medium">Balance Due</span>
                      <span className={`font-bold ${(order.keepupBalanceDue ?? 0) <= 0 ? "text-green-700" : "text-orange-600"}`}>
                        {formatCurrency(Math.max(0, order.keepupBalanceDue ?? (order.invoiceAmount - (order.keepupAmountPaid ?? 0))))}
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
                  {order.keepupLink && (
                    <a
                      href={order.keepupLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs text-brand-600 hover:underline mt-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open invoice
                    </a>
                  )}
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
            <label className="block text-xs font-medium text-gray-500 mb-1">Payment Amount (GHS)</label>
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
