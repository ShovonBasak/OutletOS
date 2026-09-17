"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { DemandForecast } from "@/components/DemandForecast";

export default function StaffSellHistoryPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Sell history</h1>
        <p className="text-xs text-ink-soft">Demand per product, and what you can still make from stock</p>
      </div>
      <DemandForecast outlet={outlet} />
    </div>
  );
}
