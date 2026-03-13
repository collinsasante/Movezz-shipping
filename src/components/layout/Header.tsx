"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Bell, Search, X, MessageCircle, Package, Menu } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useNotifications } from "@/hooks/useNotifications";
import { useSidebar } from "@/context/SidebarContext";

interface HeaderProps {
  title: string;
  subtitle?: string;
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function Header({ title, subtitle }: HeaderProps) {
  const { appUser } = useAuth();
  const role = appUser?.role ?? "";
  const { notifications, unread, markAllRead, clearAll } = useNotifications(role);
  const { openSidebar } = useSidebar();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleBell = () => {
    const next = !open;
    setOpen(next);
    if (next) markAllRead();
  };

  return (
    <header className="h-14 lg:h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {/* Hamburger — mobile only, hidden when bottom nav present */}
        <button
          onClick={openSidebar}
          className="lg:hidden p-2 -ml-1 rounded-lg hover:bg-gray-100 text-gray-500 shrink-0"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="text-base lg:text-xl font-semibold text-gray-900 truncate">{title}</h1>
          {subtitle && <p className="text-xs text-gray-500 truncate hidden sm:block">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="search"
            placeholder="Search..."
            className="h-9 w-56 pl-9 pr-3 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-gray-50"
          />
        </div>

        {/* Notification Bell */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={handleBell}
            className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5 text-gray-500" />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 bg-red-500 rounded-full text-white text-[9px] font-bold flex items-center justify-center px-0.5">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          {open && (
            <div className="fixed right-4 top-14 lg:top-auto lg:right-0 lg:absolute lg:top-full mt-0 lg:mt-2 w-[min(20rem,calc(100vw-2rem))] bg-white border border-gray-200 rounded-xl shadow-xl z-[60] overflow-hidden">
              {/* Dropdown header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <p className="font-semibold text-sm text-gray-900">
                  Notifications
                </p>
                <div className="flex items-center gap-1">
                  {notifications.length > 0 && (
                    <button
                      onClick={clearAll}
                      className="text-xs text-gray-400 hover:text-gray-600 px-2 py-0.5 rounded hover:bg-gray-100"
                    >
                      Clear all
                    </button>
                  )}
                  <button
                    onClick={() => setOpen(false)}
                    className="p-1 rounded-lg hover:bg-gray-100"
                  >
                    <X className="h-4 w-4 text-gray-400" />
                  </button>
                </div>
              </div>

              {/* Notification list */}
              <div className="max-h-80 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <Bell className="h-8 w-8 text-gray-200 mb-2" />
                    <p className="text-sm text-gray-400">No notifications yet</p>
                    <p className="text-xs text-gray-300 mt-1">
                      New messages will appear here
                    </p>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <Link
                      key={n.id}
                      href={n.href}
                      onClick={() => setOpen(false)}
                      className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-50 last:border-0 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-brand-50 border border-brand-100 flex items-center justify-center shrink-0 mt-0.5">
                        {n.id.startsWith("status_") ? (
                          <Package className="h-3.5 w-3.5 text-brand-600" />
                        ) : (
                          <MessageCircle className="h-3.5 w-3.5 text-brand-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-900">
                          {n.title}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                          {n.body}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {timeAgo(n.time)}
                        </p>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User avatar */}
        <div className="flex items-center gap-2 pl-2 sm:pl-3 border-l border-gray-200">
          <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-sm font-semibold shrink-0">
            {appUser?.email?.charAt(0).toUpperCase() ?? "U"}
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-medium text-gray-900 leading-none truncate max-w-[120px]">
              {appUser?.customerName ?? appUser?.email?.split("@")[0]}
            </p>
            <p className="text-xs text-gray-500 capitalize mt-0.5">
              {appUser?.role?.replace("_", " ")}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
