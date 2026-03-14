import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/toast";
import ChunkErrorHandler from "@/components/ChunkErrorHandler";

export const metadata: Metadata = {
  title: "PAKKmax | Freight Forwarding & Shipment Tracking",
  description:
    "PAKKmax - Professional freight forwarding from China to Ghana. Track your packages, manage orders, and get real-time WhatsApp notifications.",
  keywords: ["freight forwarding", "Ghana shipping", "China shipping", "package tracking", "PAKKmax"],
  icons: { icon: "/logowithouttext.png", shortcut: "/logowithouttext.png", apple: "/logowithouttext.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Inline handler runs before any chunks load — catches ChunkLoadError during hydration */}
        <script dangerouslySetInnerHTML={{ __html: `
(function(){window.addEventListener('error',function(e){var err=e.error;if(err&&(err.name==='ChunkLoadError'||(typeof err.message==='string'&&err.message.indexOf('Failed to load chunk')>-1))){var k='__cr_'+location.pathname;if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,'1');location.reload();}}});})();
        `}} />
      </head>
      <body className="font-sans h-full antialiased">
        <ChunkErrorHandler />
        <AuthProvider>
          <ToastProvider>
            {children}
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
