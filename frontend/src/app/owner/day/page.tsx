"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Day view now lives at /owner directly — this stub just catches old
 * bookmarks/links still pointing at /owner/day. */
export default function OwnerDayRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/owner");
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="font-mono text-sm text-ink-soft">Loading…</p>
    </main>
  );
}
