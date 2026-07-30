"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { packBreakdown } from "@/lib/format";
import type { DisplayStock, Paginated, RawStock } from "@/lib/types";

export default function StockOverview() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [raw, setRaw] = useState<RawStock[]>([]);
  const [ready, setReady] = useState<DisplayStock[]>([]);

  useEffect(() => {
    Promise.all([
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
      api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
    ]).then(([r, d]) => {
      setRaw(r.results);
      setReady(d.results);
    });
  }, [outlet]);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Stock overview</h1>
        <p className="text-xs text-ink-soft">Raw ingredients &amp; ready pieces</p>
      </div>

      <div>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Raw ingredients
        </p>
        <div className="flex flex-col gap-2">
          {raw.map((r) => {
            const packs = packBreakdown(r.quantity_available, r.pieces_per_pack, r.base_unit);
            return (
              <div key={r.id} className="listrow">
                <span className="title">{r.ingredient_name}</span>
                <div className="text-right">
                  <p className="meta">{Number(r.quantity_available)} {r.base_unit}</p>
                  {packs && (
                    <p className="font-mono text-[10px] text-ink-soft/60">= {packs}</p>
                  )}
                </div>
              </div>
            );
          })}
          {raw.length === 0 && <p className="font-mono text-xs text-ink-soft">No raw stock yet.</p>}
        </div>
      </div>

      <div>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Ready to sell
        </p>
        <div className="flex flex-col gap-2">
          {ready.map((d) => (
            <div key={d.id} className="listrow">
              <span className="title">{d.product_name}</span>
              <span className="meta">{d.pieces_available} pcs ready</span>
            </div>
          ))}
          {ready.length === 0 && (
            <p className="font-mono text-xs text-ink-soft">Nothing prepared yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
