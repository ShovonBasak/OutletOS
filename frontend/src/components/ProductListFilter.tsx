"use client";

import { useMemo, useState } from "react";
import type { Product } from "@/lib/types";

/**
 * Shared large-list pattern used by the Count and Online-sell screens:
 * search box + category filter chips. Renders each visible product via
 * `renderRow`. Rows mark themselves "done" (light green) via `isDone`.
 * Per CLAUDE.md this full-list-with-filters approach is deliberate for 23+ items.
 */
export function ProductListFilter({
  products,
  renderRow,
  isDone,
  doneLabel,
}: {
  products: Product[];
  renderRow: (p: Product) => React.ReactNode;
  isDone: (p: Product) => boolean;
  doneLabel?: (done: number, total: number) => string;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("ALL");

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category || "Other"));
    return ["ALL", ...Array.from(set)];
  }, [products]);

  const visible = products.filter((p) => {
    const matchesCat = cat === "ALL" || (p.category || "Other") === cat;
    const matchesQ = p.name.toLowerCase().includes(q.toLowerCase());
    return matchesCat && matchesQ;
  });

  const doneCount = products.filter(isDone).length;

  return (
    <div className="flex flex-col gap-3">
      <input
        className="field-input"
        placeholder="Search products…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <button
            key={c}
            className={`chip ${cat === c ? "chip-active" : ""}`}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
        {doneLabel ? doneLabel(doneCount, products.length) : `${doneCount}/${products.length} done`}
      </p>
      <div className="flex flex-col gap-2">
        {visible.map((p) => (
          <div
            key={p.id}
            className={`rounded border px-3 py-2 transition ${
              isDone(p) ? "border-leaf/40 bg-leaf/10" : "border-[#d8cdb0] bg-[#fffdf7]"
            }`}
          >
            {renderRow(p)}
          </div>
        ))}
        {visible.length === 0 && (
          <p className="py-6 text-center font-mono text-xs text-ink-soft">No products match.</p>
        )}
      </div>
    </div>
  );
}
