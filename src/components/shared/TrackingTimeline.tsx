import React from "react";
import { ITEM_STATUS_STEPS, formatDateTime, cn } from "@/lib/utils";
import type { ItemStatus, StatusHistory } from "@/types";
import { CheckCircle2, Circle, Clock } from "lucide-react";

interface TrackingTimelineProps {
  currentStatus: ItemStatus;
  history?: StatusHistory[];
  compact?: boolean;
}

const STATUS_DESCRIPTIONS: Record<ItemStatus, string> = {
  "Arrived at Transit Warehouse": "Item received at our China warehouse",
  "Shipped to Ghana": "Package loaded into container, en route to Ghana",
  "Arrived in Ghana": "Container arrived at Ghana port",
  Sorting: "Item being sorted at our Ghana warehouse",
  "Ready for Pickup": "Package ready for collection",
  Completed: "Package collected",
};

export function TrackingTimeline({
  currentStatus,
  history = [],
  compact = false,
}: TrackingTimelineProps) {
  const currentIndex = ITEM_STATUS_STEPS.indexOf(currentStatus);

  return (
    <div className={cn("relative", compact ? "space-y-2" : "space-y-1")}>
      {ITEM_STATUS_STEPS.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = index === currentIndex;
        const isPending = index > currentIndex;

        const historyEntry = history.find((h) => h.newStatus === step);

        return (
          <div key={step} className="flex gap-3">
            {/* Left column: icons + connector */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2",
                  isCompleted
                    ? "bg-green-500 border-green-500"
                    : isCurrent
                    ? "bg-brand-600 border-brand-600"
                    : "bg-white border-gray-200"
                )}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-4 w-4 text-white" />
                ) : isCurrent ? (
                  <Clock className="h-4 w-4 text-white" />
                ) : (
                  <Circle className="h-4 w-4 text-gray-300" />
                )}
              </div>
              {index < ITEM_STATUS_STEPS.length - 1 && (
                <div
                  className={cn(
                    "w-0.5 flex-1 my-1",
                    isCompleted ? "bg-green-400" : "bg-gray-100"
                  )}
                  style={{ minHeight: compact ? 16 : 24 }}
                />
              )}
            </div>

            {/* Right column: text */}
            <div className={cn("pb-1", compact ? "pb-1" : "pb-4", "min-w-0")}>
              <p
                className={cn(
                  "text-sm font-semibold leading-none",
                  isCompleted || isCurrent
                    ? "text-gray-900"
                    : "text-gray-400"
                )}
              >
                {step}
              </p>
              {!compact && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {STATUS_DESCRIPTIONS[step]}
                </p>
              )}
              {historyEntry && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {formatDateTime(historyEntry.changedAt)}
                  {historyEntry.changedBy && ` · ${historyEntry.changedBy}`}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
