"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
    } else if (user.role === "OWNER" || user.role === "ADMIN") {
      // Day view is the most-used owner screen — it's the /owner route itself.
      router.replace("/owner");
    } else {
      router.replace("/staff");
    }
  }, [user, loading, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="font-mono text-sm text-ink-soft">Loading…</p>
    </main>
  );
}
