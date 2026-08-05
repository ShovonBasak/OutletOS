"use client";

import { useMemo, useState } from "react";
import { PRODUCT_CATEGORIES } from "@/lib/types";
import type { Product } from "@/lib/types";

type TypeFilter = "ALL" | "READY" | "PREPARED";

const TYPE_OPTIONS: { key: TypeFilter; label: string; sub: string }[] = [
  { key: "ALL",      label: "All",      sub: "show everything"   },
  { key: "READY",    label: "Ready",    sub: "auto-filled"       },
  { key: "PREPARED", label: "Prepared", sub: "starts at 0"       },
];

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
  showTypeFilter,
  rawItems,
}: {
  products: Product[];
  renderRow: (p: Product) => React.ReactNode;
  isDone: (p: Product) => boolean;
  doneLabel?: (done: number, total: number) => string;
  showTypeFilter?: boolean;
  /** When true, skip the per-item wrapper div so renderRow can own all styling. */
  rawItems?: boolean;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");

  const categories = useMemo(() => {
    const present = new Set(products.map((p) => p.category || "Other"));
    const ordered = PRODUCT_CATEGORIES.filter((c) => present.has(c));
    const rest = Array.from(present).filter((c) => !PRODUCT_CATEGORIES.includes(c as never)).sort();
    return ["ALL", ...ordered, ...rest];
  }, [products]);

  const visible = products.filter((p) => {
    const matchesCat = cat === "ALL" || (p.category || "Other") === cat;
    const matchesQ = p.name.toLowerCase().includes(q.toLowerCase());
    const matchesType =
      !showTypeFilter ||
      typeFilter === "ALL" ||
      (typeFilter === "READY" && !p.requires_preparation) ||
      (typeFilter === "PREPARED" && !!p.requires_preparation);
    return matchesCat && matchesQ && matchesType;
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

      {/* Category chips */}
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

      {/* Type filter — segmented control, count page only */}
      {showTypeFilter && (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-soft/70">
            Product type
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {TYPE_OPTIONS.map(({ key, label, sub }) => (
              <button
                key={key}
                onClick={() => setTypeFilter(key)}
                className={`flex flex-col items-center rounded border py-2 transition ${
                  typeFilter === key
                    ? key === "READY"
                      ? "border-leaf/60 bg-leaf/10 text-leaf-deep"
                      : key === "PREPARED"
                      ? "border-[#7A2420]/40 bg-[#7A2420]/5 text-[#7A2420]"
                      : "border-ink/30 bg-paper-dim text-ink"
                    : "border-[#d8cdb0] bg-paper text-ink-soft"
                }`}
              >
                <span className="font-mono text-xs font-semibold">{label}</span>
                <span className="font-mono text-[9px] opacity-60">{sub}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
        {doneLabel ? doneLabel(doneCount, products.length) : `${doneCount}/${products.length} done`}
      </p>

      <div className="flex flex-col gap-2">
        {visible.map((p) =>
          rawItems ? (
            <div key={p.id}>{renderRow(p)}</div>
          ) : (
            <div
              key={p.id}
              className={`rounded border px-3 py-2 transition ${
                isDone(p) ? "border-leaf/40 bg-leaf/10" : "border-[#d8cdb0] bg-[#fffdf7]"
              }`}
            >
              {renderRow(p)}
            </div>
          )
        )}
        {visible.length === 0 && (
          <p className="py-6 text-center font-mono text-xs text-ink-soft">No products match.</p>
        )}
      </div>
    </div>
  );
}
