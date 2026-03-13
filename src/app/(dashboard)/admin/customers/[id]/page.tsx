"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { DataTable } from "@/components/shared/DataTable";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Customer, Item, Order } from "@/types";
import {
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Tag,
  Package,
  ShoppingCart,
  Edit2,
  Check,
  X,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import axios from "axios";

interface CustomerDetail extends Customer {
  items: Item[];
  orders: Order[];
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error, success } = useToast();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", email: "", notes: "", status: "active" as "active" | "inactive", shippingType: "" as "air" | "sea" | "", shippingAddress: "", package: "" as "standard" | "discounted" | "premium" | "special" | "" });
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`/api/customers/${id}`);
        const c = res.data.data;
        setCustomer(c);
        if (searchParams.get("edit") === "true") {
          setEditForm({
            name: c.name ?? "",
            phone: c.phone ?? "",
            email: c.email ?? "",
            notes: c.notes ?? "",
            status: c.status ?? "active",
            shippingType: c.shippingType ?? "",
            shippingAddress: c.shippingAddress ?? "",
            package: c.package ?? "",
          });
          setEditing(true);
        }
      } catch {
        error("Failed to load customer");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, error, searchParams]);

  const openEdit = () => {
    if (!customer) return;
    setEditForm({
      name: customer.name ?? "",
      phone: customer.phone ?? "",
      email: customer.email ?? "",
      notes: customer.notes ?? "",
      status: customer.status ?? "active",
      shippingType: customer.shippingType ?? "",
      shippingAddress: customer.shippingAddress ?? "",
      package: customer.package ?? "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      const res = await axios.patch(`/api/customers/${id}`, {
        ...editForm,
        shippingType: editForm.shippingType || undefined,
        shippingAddress: editForm.shippingAddress || undefined,
        package: editForm.package || undefined,
      });
      setCustomer((prev) => prev ? { ...prev, ...res.data.data } : prev);
      success("Customer updated");
      setEditing(false);
    } catch {
      error("Failed to update customer");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`/api/customers/${id}`);
      success("Customer deleted");
      router.push("/admin/customers");
    } catch {
      error("Failed to delete customer");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">Customer not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Header title={customer.name} subtitle={customer.shippingMark} />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-2">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-red-600">Delete customer?</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-300 text-red-600 hover:bg-red-50"
                  loading={deleting}
                  onClick={handleDelete}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 text-red-600 hover:bg-red-50"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Delete
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Profile Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Customer Profile</span>
                {!editing ? (
                  <button onClick={openEdit} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                    <Edit2 className="h-4 w-4" />
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <button onClick={saveEdit} disabled={savingEdit} className="p-1.5 rounded-lg hover:bg-green-50 text-green-600 transition-colors disabled:opacity-50">
                      <Check className="h-4 w-4" />
                    </button>
                    <button onClick={() => setEditing(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {editing ? (
                <div className="space-y-3">
                  <Input label="Full Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                  <Input label="Phone" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
                  <Input label="Email" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
                  <Input label="Shipping Address" value={editForm.shippingAddress} onChange={(e) => setEditForm({ ...editForm, shippingAddress: e.target.value })} />
                  <div className="grid grid-cols-2 gap-3">
                    <Select
                      label="Status"
                      value={editForm.status}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value as "active" | "inactive" })}
                      options={[
                        { value: "active", label: "Active" },
                        { value: "inactive", label: "Inactive" },
                      ]}
                    />
                    <Select
                      label="Shipping Type"
                      value={editForm.shippingType}
                      onChange={(e) => setEditForm({ ...editForm, shippingType: e.target.value as "air" | "sea" | "" })}
                      options={[
                        { value: "", label: "Not set" },
                        { value: "air", label: "Air Freight" },
                        { value: "sea", label: "Sea Freight" },
                      ]}
                    />
                  </div>
                  <Select
                    label="Package"
                    value={editForm.package}
                    onChange={(e) => setEditForm({ ...editForm, package: e.target.value as "standard" | "discounted" | "premium" | "special" | "" })}
                    options={[
                      { value: "", label: "No package" },
                      { value: "standard", label: "Basic Shipping" },
                      { value: "discounted", label: "Business Shipping" },
                      { value: "premium", label: "Enterprise Shipping" },
                      { value: "special", label: "Special" },
                    ]}
                  />
                  <Textarea label="Notes (optional)" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} />
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditing(false)} disabled={savingEdit}>Cancel</Button>
                    <Button size="sm" className="flex-1" onClick={saveEdit} loading={savingEdit}>Save Changes</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-xl">
                      {customer.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">{customer.name}</p>
                      <StatusBadge status={customer.status} />
                    </div>
                  </div>

                  <div className="space-y-2.5 pt-2">
                    <InfoRow icon={Mail} label="Email" value={customer.email} />
                    <InfoRow icon={Phone} label="Phone" value={customer.phone} />
                    <InfoRow icon={MapPin} label="Shipping Address" value={customer.shippingAddress} />
                    <InfoRow icon={Tag} label="Shipping Mark">
                      <code className="text-xs font-mono bg-brand-50 text-brand-700 px-2 py-1 rounded font-bold">
                        {customer.shippingMark}
                      </code>
                    </InfoRow>
                    {customer.shippingType && (
                      <InfoRow icon={Package} label="Shipping Type" value={customer.shippingType === "air" ? "Air Freight" : "Sea Freight"} />
                    )}
                    {customer.package && (
                      <InfoRow icon={Package} label="Package">
                        <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize inline-block mt-0.5 ${
                          customer.package === "premium" ? "bg-amber-50 text-amber-700" :
                          customer.package === "discounted" ? "bg-blue-50 text-blue-700" :
                          "bg-gray-100 text-gray-700"
                        }`}>
                          {customer.package === "standard" ? "Basic Shipping" : customer.package === "discounted" ? "Business Shipping" : customer.package === "premium" ? "Enterprise Shipping" : customer.package === "special" ? "Special" : customer.package}
                        </span>
                      </InfoRow>
                    )}
                    <InfoRow icon={Package} label="Member Since" value={formatDate(customer.createdAt)} />
                  </div>

                  {customer.notes && (
                    <div className="pt-2 border-t border-gray-100">
                      <p className="text-xs text-gray-500 mb-1">Notes</p>
                      <p className="text-sm text-gray-700">{customer.notes}</p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Items + Orders */}
          <div className="lg:col-span-2 space-y-6">
            {/* Items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900">Items</h3>
                <Button
                  size="sm"
                  onClick={() =>
                    router.push(`/admin/items/new?customerId=${id}`)
                  }
                >
                  <Package className="h-3.5 w-3.5 mr-1.5" />
                  Add Item
                </Button>
              </div>
              <DataTable
                columns={[
                  {
                    key: "itemRef",
                    header: "Ref",
                    render: (item) => (
                      <span className="font-mono text-xs font-bold">
                        {item.itemRef}
                      </span>
                    ),
                  },
                  {
                    key: "description",
                    header: "Description",
                    render: (item) => (
                      <span className="text-sm truncate max-w-[180px] block">
                        {item.description}
                      </span>
                    ),
                  },
                  {
                    key: "weight",
                    header: "Weight",
                    render: (item) => (
                      <span className="text-sm">{item.weight} kg</span>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (item) => <StatusBadge status={item.status} />,
                  },
                  {
                    key: "dateReceived",
                    header: "Received",
                    render: (item) => (
                      <span className="text-xs text-gray-500">
                        {formatDate(item.dateReceived)}
                      </span>
                    ),
                  },
                ]}
                data={customer.items ?? []}
                keyExtractor={(item) => item.id}
                emptyMessage="No items yet"
                onRowClick={(item) =>
                  router.push(`/admin/items/${item.id}`)
                }
              />
            </div>

            {/* Orders */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900">Invoices</h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    router.push(`/admin/orders/new?customerId=${id}`)
                  }
                >
                  <ShoppingCart className="h-3.5 w-3.5 mr-1.5" />
                  New Invoice
                </Button>
              </div>
              <DataTable
                columns={[
                  {
                    key: "orderRef",
                    header: "Invoice",
                    render: (o) => (
                      <span className="font-mono text-xs font-bold">
                        {o.orderRef}
                      </span>
                    ),
                  },
                  {
                    key: "invoiceAmount",
                    header: "Amount",
                    render: (o) => (
                      <span className="font-semibold">
                        {formatCurrency(o.invoiceAmount)}
                      </span>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (o) => <StatusBadge status={o.status} />,
                  },
                  {
                    key: "invoiceDate",
                    header: "Date",
                    render: (o) => (
                      <span className="text-xs text-gray-500">
                        {formatDate(o.invoiceDate)}
                      </span>
                    ),
                  },
                ]}
                data={customer.orders ?? []}
                keyExtractor={(o) => o.id}
                emptyMessage="No orders yet"
                onRowClick={(o) => router.push(`/admin/orders/${o.id}`)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  icon: _Icon,
  label,
  value,
  children,
}: {
  icon: React.ElementType;
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      {children ?? (
        <p className="text-sm text-gray-800 font-medium break-words">
          {value ?? "—"}
        </p>
      )}
    </div>
  );
}
