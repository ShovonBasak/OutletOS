"use client";

import { DemandForecast } from "@/components/DemandForecast";
import { useOwnerOutlet } from "@/lib/ownerOutlet";

export default function SellHistoryPage() {
  const { selectedOutlet } = useOwnerOutlet();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">Sell history</h1>
        <p className="text-xs text-ink-soft">Demand per product, and what you can still make from stock</p>
      </div>
      {selectedOutlet && <DemandForecast outlet={selectedOutlet.id} />}
    </div>
  );
}
