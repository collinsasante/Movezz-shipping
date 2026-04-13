"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { Loader2 } from "lucide-react";
import Image from "next/image";

// Root page — redirect based on authenticated role
export default function RootPage() {
  const { appUser, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    if (!appUser) {
      router.replace("/login");
      return;
    }

    if (appUser.role === "customer") {
      router.replace("/customer");
    } else {
      router.replace("/admin");
    }
  }, [appUser, loading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <Image src="/Logo.jpeg" alt="De-MOVEZZ LOGISTICS" width={64} height={64} className="rounded-2xl mx-auto mb-4" />
        <Loader2 className="h-5 w-5 animate-spin text-brand-600 mx-auto mt-2" />
        <p className="text-sm text-gray-500 mt-2">Loading De-MOVEZZ LOGISTICS...</p>
      </div>
    </div>
  );
}
