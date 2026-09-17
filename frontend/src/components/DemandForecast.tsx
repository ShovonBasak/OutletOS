"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { groupByCategory, packBreakdown, today } from "@/lib/format";
import type { DateHours, ProductStockDetail, SellHistoryResponse, SellHistoryRow } from "@/lib/types";

const COL_W = 24; // px, matches the fixed bar-column width used throughout the charts below
const COL_GAP = 4;
const CHART_H = 44;

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${parseInt(d)}/${m}`;
}

function fmtDay(iso: string) {
  return String(parseInt(iso.split("-")[2]));
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function stockColor(stock: number | null) {
  return stock === null ? "text-ink-soft" : stock === 0 ? "text-chili" : stock <= 5 ? "text-gold-deep" : "text-leaf-deep";
}

const RANGE_PRESETS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
];

// Add-ons (extra cheese, sauce, ketchup) are orderable but aren't dishes on
// the menu in the sense this view forecasts — they clutter the list without
// a meaningful stock-on-hand story of their own. Still reachable by search
// if ever needed; just not shown by default. Easy to revisit if wrong.
const HIDDEN_CATEGORIES = new Set(["Add-on"]);

/**
 * Order-forecasting view: for every menu product, units sold per day next to
 * that day's available stock (so a quiet day can be read correctly — no
 * stock that day, or a real lull in demand), plus how many more units can be
 * made from raw stock right now. Tapping a product breaks that current-stock
 * figure down by ingredient, so a low number is explained (e.g. a Burger is
 * stuck at 0 because Buns ran out, even though Zinger Fillet stock is fine).
 *
 * Products are grouped by menu category. Each chart combines a bar (units
 * sold) with a connected line (units available that day) on the same axis,
 * so a quiet day next to a flat/low line reads as "no stock", and a quiet
 * day next to a high line reads as "genuinely low demand".
 *
 * Renders a compact card list on narrow screens, and a full date-by-date
 * matrix (sold + that day's stock, stacked) plus a trend chart from `md:` up.
 * Shared between staff and owner.
 */
export function DemandForecast({ outlet = 1 }: { outlet?: number }) {
  const [start, setStart] = useState(daysAgo(14));
  const [end, setEnd] = useState(today());
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SellHistoryResponse | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<SellHistoryResponse>(
        `/reports/sell-history/?outlet=${outlet}&start=${start}&end=${end}`
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [outlet, start, end]);

  useEffect(() => {
    load();
  }, [load]);

  function setPreset(days: number) {
    setStart(daysAgo(days));
    setEnd(today());
  }

  const menuRows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => !HIDDEN_CATEGORIES.has(r.category));
  }, [data]);

  const categories = useMemo(() => {
    return ["All", ...Array.from(new Set(menuRows.map((r) => r.category).filter(Boolean))).sort()];
  }, [menuRows]);

  const filtered = useMemo(() => {
    return menuRows.filter((r) => {
      const matchCat = catFilter === "All" || r.category === catFilter;
      const matchSearch = !search || r.name.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [menuRows, catFilter, search]);

  const groups = useMemo(() => groupByCategory(filtered, (r) => r.category), [filtered]);

  const dates = data?.dates ?? [];

  function toggle(id: number) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Demand vs. stock on hand</p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-ink-soft/80">
          Each chart combines two things: the <b>bars</b> are units sold, the <b>orange line</b> is units
          available that day. A quiet day with a low line means there was nothing to sell — not low demand.
          A quiet day with a high line is a real lull. <b>Stock</b> (right) is how many more units can be made
          from ingredients on hand right now. <span className="text-chili-deep">Tap a product</span> to see
          which ingredient is limiting it.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.days}
              onClick={() => setPreset(p.days)}
              className={`chip ${daysAgo(p.days) === start && today() === end ? "chip-active" : ""}`}
            >
              {p.label}
            </button>
          ))}
          <input type="date" className="field-input !w-auto !py-1 !text-[11px]" value={start} onChange={(e) => setStart(e.target.value)} />
          <span className="font-mono text-xs text-ink-soft">→</span>
          <input type="date" className="field-input !w-auto !py-1 !text-[11px]" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <input
          type="text"
          className="field-input max-w-xs !py-1.5 text-sm"
          placeholder="Search product…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => (
            <button key={cat} onClick={() => setCatFilter(cat)} className={`chip ${catFilter === cat ? "chip-active" : ""}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="font-mono text-xs text-ink-soft">Loading…</p>}
      {!loading && filtered.length === 0 && <p className="font-mono text-xs text-ink-soft">No data for the selected period.</p>}

      {!loading && filtered.length > 0 && (
        <>
          <HoursTimeline dates={dates} dateHours={data?.date_hours ?? {}} />

          {/* Mobile: cards, grouped by category */}
          <div className="flex flex-col gap-3 md:hidden">
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-2">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                  {group.icon} {group.key}
                </p>
                {group.items.map((row) => (
                  <ProductCard key={row.id} row={row} dates={dates} outlet={outlet} isOpen={expanded === row.id} onToggle={toggle} />
                ))}
              </div>
            ))}
          </div>

          {/* Desktop: date matrix (sold + that day's stock) + trend chart + current stock */}
          <div className="hidden overflow-x-auto md:block">
            <table className="datatable w-full" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
              <thead>
                <tr>
                  <th>Product</th>
                  {dates.map((d) => (
                    <th key={d} className="!text-right">{fmtDate(d)}</th>
                  ))}
                  <th className="!text-right">Total</th>
                  <th className="!text-right">Trend</th>
                  <th className="!text-right">Stock</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <ProductGroupRows key={group.key} group={group} dates={dates} outlet={outlet} expanded={expanded} onToggle={toggle} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Timeline strip, one row per date, showing exactly when the shop opened
 * and closed that day (both times, as text) plus a horizontal position bar
 * on a 24-hour scale so the pattern across days reads at a glance. Shown
 * once above the product list rather than repeated per product, since it's
 * the same context for every product on a given day. */
function HoursTimeline({ dates, dateHours }: { dates: string[]; dateHours: Record<string, DateHours> }) {
  return (
    <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2.5 py-2">
      <p className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">Shop hours</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {dates.map((d) => {
          const dh = dateHours[d];
          const hasData = dh?.opened_at != null;
          const openDate = hasData ? new Date(dh.opened_at as string) : null;
          const closeDate = dh?.closed_at ? new Date(dh.closed_at) : null;
          const pct = (dt: Date) => ((dt.getHours() * 60 + dt.getMinutes()) / 1440) * 100;
          const openPct = openDate ? pct(openDate) : 0;
          const closePct = closeDate ? pct(closeDate) : null;
          const short = dh?.hours_open != null && dh.hours_open < 8;
          return (
            <div key={d} className="flex items-center gap-2">
              <span className="w-7 shrink-0 font-mono text-[9px] text-ink-soft">{fmtDay(d)}</span>
              <div className="relative h-1.5 flex-1 rounded-full bg-ink-soft/10">
                {hasData && closePct !== null && (
                  <div
                    className={`absolute h-1.5 rounded-full ${short ? "bg-chili/70" : "bg-gold/70"}`}
                    style={{ left: `${openPct}%`, width: `${Math.max(1, closePct - openPct)}%` }}
                  />
                )}
              </div>
              <span className={`w-[92px] shrink-0 text-right font-mono text-[9px] ${short ? "font-semibold text-chili-deep" : "text-ink-soft"}`}>
                {hasData ? `${fmtTime(dh!.opened_at as string)} – ${dh?.closed_at ? fmtTime(dh.closed_at) : "open"}` : "no data"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Small unlabeled shape-only indicator for the desktop Trend column — the
 * matrix already shows exact sold + stock numbers per date, so this is just
 * "does it trend up or down", not another full chart to parse. */
function Sparkline({ dates, daily }: { dates: string[]; daily: Record<string, number> }) {
  const values = dates.map((d) => daily[d] ?? 0);
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-6 items-end gap-px">
      {values.map((v, i) => (
        <div
          key={i}
          className={`w-1 rounded-sm ${v === 0 ? "bg-ink-soft/15" : "bg-chrome/60"}`}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
          title={`${dates[i]}: ${v}`}
        />
      ))}
    </div>
  );
}

/** Combined bar + line chart on a shared scale: bars are units sold, the
 * connected orange line is units available that day (from daily_stock).
 * Fixed pixel columns (not percentage widths) so it scrolls as one block
 * alongside the day labels for wide date ranges, same as the rest of this
 * view's charts. Pure SVG for the line — no charting library needed. */
function ComboChart({ dates, daily, dailyStock }: { dates: string[]; daily: Record<string, number>; dailyStock: Record<string, number | null> }) {
  const soldValues = dates.map((d) => daily[d] ?? 0);
  const stockValues = dates.map((d) => dailyStock[d] ?? null);
  const knownStock = stockValues.filter((v): v is number => v !== null);
  const max = Math.max(1, ...soldValues, ...knownStock);
  const colStep = COL_W + COL_GAP;
  const width = dates.length * colStep - COL_GAP;

  const points = stockValues
    .map((v, i) => (v === null ? null : { x: i * colStep + COL_W / 2, y: CHART_H - (v / max) * CHART_H }))
    .filter((p): p is { x: number; y: number } => p !== null);
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height: 11 + CHART_H + 11 }}>
        <div className="absolute inset-x-0 top-0 flex gap-1" style={{ height: 11 }}>
          {soldValues.map((v, i) => (
            <span key={i} style={{ width: COL_W }} className="shrink-0 text-center font-mono text-[8px] font-semibold leading-none text-ink">
              {v > 0 ? v : ""}
            </span>
          ))}
        </div>
        <div className="absolute inset-x-0 flex items-end gap-1" style={{ top: 11, height: CHART_H }}>
          {soldValues.map((v, i) => (
            <div
              key={i}
              style={{ width: COL_W, height: v === 0 ? 3 : Math.max(4, (v / max) * CHART_H) }}
              className={`shrink-0 rounded-sm ${v === 0 ? "bg-ink-soft/15" : "bg-chrome/60"}`}
            />
          ))}
        </div>
        {points.length > 0 && (
          <svg className="absolute left-0" style={{ top: 11, width, height: CHART_H, overflow: "visible" }}>
            <polyline points={linePoints} fill="none" stroke="#C9601C" strokeWidth={1.5} />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2.2} fill="#C9601C" stroke="#fffdf7" strokeWidth={1} />
            ))}
          </svg>
        )}
        <div className="absolute inset-x-0 flex gap-1" style={{ top: 11 + CHART_H, height: 11 }}>
          {dates.map((d, i) => (
            <span key={i} style={{ width: COL_W }} className="shrink-0 text-center font-mono text-[8px] leading-none text-ink-soft/70">
              {fmtDay(d)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function IngredientBreakdown({ productId, outlet }: { productId: number; outlet: number }) {
  const [detail, setDetail] = useState<ProductStockDetail | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    api<ProductStockDetail>(`/reports/product-stock-detail/?outlet=${outlet}&product=${productId}`)
      .then(setDetail)
      .finally(() => setLoaded(true));
  }, [productId, outlet]);

  if (!loaded) return <p className="font-mono text-[10px] text-ink-soft">Loading…</p>;
  if (!detail || detail.ingredients.length === 0) {
    return <p className="font-mono text-[10px] text-ink-soft">No recipe ingredients to break down.</p>;
  }

  return (
    <div className="flex flex-col gap-1.5 font-mono text-[11px]">
      {detail.ingredients.map((ing) => {
        const note = packBreakdown(ing.quantity_available, ing.pieces_per_pack, ing.base_unit);
        return (
          <div key={ing.ingredient_id} className={`flex items-baseline justify-between gap-2 ${ing.is_bottleneck ? "text-chili-deep font-semibold" : ""}`}>
            <span>
              {ing.is_bottleneck && "⚠️ "}
              {ing.ingredient_name}
            </span>
            <span className="shrink-0 text-right">
              {ing.pieces_possible} pcs possible
              <span className="text-ink-soft"> ({ing.quantity_available} {ing.base_unit}{note ? ` = ${note}` : ""})</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProductCard({
  row,
  dates,
  outlet,
  isOpen,
  onToggle,
}: {
  row: SellHistoryRow;
  dates: string[];
  outlet: number;
  isOpen: boolean;
  onToggle: (id: number) => void;
}) {
  return (
    <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2.5 py-2">
      <div className="cursor-pointer" onClick={() => onToggle(row.id)}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[12.5px] font-semibold leading-tight">
            {isOpen ? "▾" : "▸"} {row.name}
          </span>
          <span className={`shrink-0 font-mono text-[13px] font-semibold ${stockColor(row.stock)}`}>
            {row.stock === null ? "—" : row.stock}
          </span>
        </div>
        <div className="mt-1.5">
          <ComboChart dates={dates} daily={row.daily} dailyStock={row.daily_stock} />
        </div>
        <p className="mt-1 font-mono text-[10px] text-ink-soft">{row.total} sold in this period</p>
      </div>
      {isOpen && (
        <div className="mt-2 border-t border-dotted border-[#d8cdb0] pt-2">
          <IngredientBreakdown productId={row.id} outlet={outlet} />
        </div>
      )}
    </div>
  );
}

function ProductGroupRows({
  group,
  dates,
  outlet,
  expanded,
  onToggle,
}: {
  group: { key: string; icon: string; items: SellHistoryRow[] };
  dates: string[];
  outlet: number;
  expanded: number | null;
  onToggle: (id: number) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={dates.length + 4} className="bg-paper-dim font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
          {group.icon} {group.key}
        </td>
      </tr>
      {group.items.map((row) => (
        <ProductRows key={row.id} row={row} dates={dates} outlet={outlet} isOpen={expanded === row.id} onToggle={onToggle} />
      ))}
    </>
  );
}

function ProductRows({
  row,
  dates,
  outlet,
  isOpen,
  onToggle,
}: {
  row: SellHistoryRow;
  dates: string[];
  outlet: number;
  isOpen: boolean;
  onToggle: (id: number) => void;
}) {
  return (
    <>
      <tr className="cursor-pointer" onClick={() => onToggle(row.id)}>
        <td className="truncate">
          {isOpen ? "▾" : "▸"} {row.name}
        </td>
        {dates.map((d) => {
          const qty = row.daily[d] ?? 0;
          const avail = row.daily_stock[d] ?? null;
          return (
            <td key={d} className="text-right">
              <div className={`num ${qty === 0 ? "text-ink-soft/40" : ""}`}>{qty === 0 ? "—" : qty}</div>
              {avail !== null && <div className="font-mono text-[9px] text-ink-soft/60">▸{avail}</div>}
            </td>
          );
        })}
        <td className="text-right num font-semibold">{row.total}</td>
        <td className="text-right">
          <div className="flex justify-end">
            <Sparkline dates={dates} daily={row.daily} />
          </div>
        </td>
        <td className={`text-right num font-semibold ${stockColor(row.stock)}`}>{row.stock === null ? "—" : row.stock}</td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={dates.length + 4} className="bg-paper-dim !border-b !border-dotted !border-[#d8cdb0]">
            <IngredientBreakdown productId={row.id} outlet={outlet} />
          </td>
        </tr>
      )}
    </>
  );
}
