"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Order } from "@/types";
import axios from "axios";
import { ArrowLeft, FileText, ExternalLink } from "lucide-react";

export default function CustomerInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    axios.get(`/api/orders/${id}`)
      .then((res) => setOrder(res.data.data))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shrink-0">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {order && (
          <>
            <span className="text-gray-300">|</span>
            <span className="text-sm font-mono font-medium text-gray-700">{order.orderRef}</span>
            {order.keepupLink && (
              <a
                href={order.keepupLink}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-xs text-brand-600 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open in new tab
              </a>
            )}
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
          </div>
        ) : order?.keepupLink ? (
          <iframe
            src={order.keepupLink}
            className="w-full h-full border-0"
            title={`Invoice ${order.orderRef}`}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
            <FileText className="h-10 w-10 text-gray-200" />
            <div>
              <p className="text-gray-500 font-medium">Invoice not available yet</p>
              <p className="text-sm text-gray-400 mt-1">Contact PAKKmax for details.</p>
            </div>
            {order?.keepupSaleId && (
              <a
                href={`https://keepup.store`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                View on Keepup
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
