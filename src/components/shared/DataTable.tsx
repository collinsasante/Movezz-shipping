import React from "react";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyIcon?: React.ReactNode;
  // Pagination
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  // Optional row click
  onRowClick?: (item: T) => void;
  // Optional per-row class names
  rowClassName?: (item: T) => string;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  loading,
  emptyMessage = "No records found",
  emptyIcon,
  page = 1,
  totalPages = 1,
  onPageChange,
  onRowClick,
  rowClassName,
}: DataTableProps<T>) {
  const emptyState = (
    <div className="px-4 py-12 text-center">
      {emptyIcon && (
        <div className="flex justify-center mb-2 text-gray-300">{emptyIcon}</div>
      )}
      <p className="text-sm text-gray-500">{emptyMessage}</p>
    </div>
  );

  const loadingState = (
    <div className="px-4 py-12 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-brand-500 mx-auto" />
      <p className="text-sm text-gray-500 mt-2">Loading...</p>
    </div>
  );

  const pagination = totalPages > 1 && onPageChange && (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
      <p className="text-xs text-gray-500">
        Page {page} of {totalPages}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider",
                    col.className
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={columns.length}>{loadingState}</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{emptyState}</td>
              </tr>
            ) : (
              data.map((item) => (
                <tr
                  key={keyExtractor(item)}
                  onClick={() => onRowClick?.(item)}
                  className={cn(
                    "hover:bg-gray-50 transition-colors",
                    onRowClick && "cursor-pointer",
                    rowClassName?.(item)
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn("px-4 py-3 text-gray-700", col.className)}
                    >
                      {col.render
                        ? col.render(item)
                        : String((item as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden">
        {loading ? (
          loadingState
        ) : data.length === 0 ? (
          emptyState
        ) : (
          <div className="divide-y divide-gray-100">
            {data.map((item) => (
              <div
                key={keyExtractor(item)}
                onClick={() => onRowClick?.(item)}
                className={cn(
                  "px-4 py-3 transition-colors",
                  onRowClick && "cursor-pointer active:bg-gray-50",
                  rowClassName?.(item)
                )}
              >
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  {columns.map((col) => (
                    <div key={col.key} className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                        {col.header}
                      </span>
                      <div className="text-sm text-gray-800 break-words">
                        {col.render
                          ? col.render(item)
                          : String((item as Record<string, unknown>)[col.key] ?? "")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pagination}
    </div>
  );
}
