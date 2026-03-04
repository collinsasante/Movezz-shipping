import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Pakkmaxx | Freight Forwarding & Shipment Tracking",
  description:
    "Pakkmaxx - Professional freight forwarding from China to Ghana. Track your packages, manage orders, and get real-time WhatsApp notifications.",
  keywords: ["freight forwarding", "Ghana shipping", "China shipping", "package tracking", "Pakkmaxx"],
  icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="font-sans h-full antialiased">
        <AuthProvider>
          <ToastProvider>
            {children}
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
