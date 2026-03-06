"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

interface SidebarContextValue {
  open: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  open: false,
  openSidebar: () => {},
  closeSidebar: () => {},
});

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSidebar = useCallback(() => setOpen(true), []);
  const closeSidebar = useCallback(() => setOpen(false), []);
  return (
    <SidebarContext.Provider value={{ open, openSidebar, closeSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
