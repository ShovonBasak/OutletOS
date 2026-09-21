"use client";

import { DemandForecast } from "@/components/DemandForecast";

export default function SellHistoryPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">Sell history</h1>
        <p className="text-xs text-ink-soft">Demand per product, and what you can still make from stock</p>
      </div>
      <DemandForecast outlet={1} />
    </div>
  );
}
