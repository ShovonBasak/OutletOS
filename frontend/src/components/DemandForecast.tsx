"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { groupByCategory, packBreakdown, shortDate, today } from "@/lib/format";
import { PRODUCT_CATEGORIES } from "@/lib/types";
import type { DateHours, ProductStockDetail, SellHistoryResponse, SellHistoryRow } from "@/lib/types";

const COL_W = 24; // px, matches the fixed bar-column width used throughout the charts below
const COL_GAP = 4;
const CHART_H = 44;
const TOP_LABEL_H = 11;
const BOTTOM_LABEL_H = 20; // two stacked lines: weekday letter + day-of-month number

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

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"]; // Date.getDay(): 0=Sun..6=Sat

/** Single-letter weekday marker — paired with the day-of-month number
 * everywhere it's shown, so "17 T" reads unambiguously once you know which
 * month you're looking at, without spending the width a full name would need. */
function weekdayLetter(iso: string): string {
  return WEEKDAY_LETTERS[new Date(`${iso}T12:00:00`).getDay()];
}

function weekdayShort(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

/** Dhaka's business weekend is Friday–Saturday (not Sunday) — flagging these
 * two days makes the weekly demand pattern (usually the busiest) pop out at
 * a glance instead of blending into the rest of the week. */
function isWeekendDay(iso: string): boolean {
  const day = new Date(`${iso}T12:00:00`).getDay();
  return day === 5 || day === 6;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function stockColor(stock: number | null) {
  return stock === null ? "text-ink-soft" : stock === 0 ? "text-chili" : stock <= 5 ? "text-gold-deep" : "text-leaf-deep";
}

/** Pack breakdown of the raw stock behind the "makeable now" number — e.g.
 * "1 pack + 5 piece" — so staff can see it in the same terms a delivery/
 * physical count comes in, not just a converted product-unit figure. */
function stockPackNote(pack: SellHistoryRow["stock_pack"]): string | null {
  if (!pack) return null;
  return packBreakdown(pack.quantity_available, pack.pieces_per_pack, pack.base_unit);
}

/** A day only counts toward the "demand" average if we know there was stock
 * to sell that day (daily_stock > 0) — days with no stock, or no closing
 * record at all, can't tell us anything about demand and would just water
 * the number down. Days with zero stock are counted separately as an
 * explicit "out of stock" signal instead. */
function summaryStats(row: SellHistoryRow, dates: string[]) {
  let daysInStock = 0;
  let stockoutDays = 0;
  for (const d of dates) {
    const s = row.daily_stock[d];
    if (s === 0) stockoutDays++;
    else if (s !== null && s !== undefined && s > 0) daysInStock++;
  }
  const avgPerDayInStock = daysInStock > 0 ? row.total / daysInStock : null;
  return { daysInStock, stockoutDays, avgPerDayInStock };
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
 * Order-forecasting view: one summary card per menu product — total sold,
 * demand rate, and how many more units can be made from raw stock right now.
 * Tapping a card expands its full day-by-day chart (bars = units sold,
 * orange line = that day's raw stock — day-start reading plus anything
 * received that same day) so a quiet day can be read correctly — no stock
 * that day vs. a real lull in demand — and breaks the
 * current-stock figure down by ingredient, so a low number is explained
 * (e.g. a Burger is stuck at 5 because Buns ran low, even though Zinger
 * Fillet stock is fine — the lower of the two is what's shown).
 *
 * Renders a compact, grouped card list on narrow screens, and a full
 * date-by-date matrix on `md:` up where there's room for it at a glance.
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
    // Same order as the closing count screen's category chips
    // (ProductListFilter / PRODUCT_CATEGORIES), not alphabetical.
    const present = new Set(menuRows.map((r) => r.category).filter(Boolean));
    const ordered = PRODUCT_CATEGORIES.filter((c) => present.has(c));
    const rest = Array.from(present).filter((c) => !(PRODUCT_CATEGORIES as readonly string[]).includes(c)).sort();
    return ["All", ...ordered, ...rest];
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
      <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2.5 py-2">
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Demand vs. stock on hand</p>
        <ul className="mt-1.5 flex flex-col gap-1 font-mono text-[10px] leading-snug text-ink-soft/80">
          <li className="flex gap-1.5">
            <span className="text-ink-soft/50">•</span>
            <span><b className="text-ink">Avg/day</b> only counts days there was stock to sell — a quiet day with no stock isn&apos;t low demand.</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-ink-soft/50">•</span>
            <span><span className="text-chili-deep font-semibold">Tap a product</span> to open its day-by-day chart.</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-ink-soft/50">•</span>
            <span>In that chart: bars = sold that day (<span className="text-chili-deep">✕</span> = out of stock,{" "}
              <span className="text-leaf-deep">green</span> = sold out) · orange line = stock that day.</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-ink-soft/50">•</span>
            <span>For a dish made of several ingredients, whichever one is lowest (marked <b className="text-ink">← limit</b>) caps how many can be made.</span>
          </li>
        </ul>
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

          {/* Mobile: summary cards, grouped by category — tap to expand the chart */}
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
                    <th key={d} className="!text-right">
                      <div>{fmtDate(d)}</div>
                      <div className={`font-normal normal-case ${isWeekendDay(d) ? "text-gold-deep" : "text-ink-soft"}`}>
                        {weekdayLetter(d)}
                      </div>
                    </th>
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

/** Collapsed by default (a full per-day timeline was too busy to be useful
 * at a glance) — shows a one-line summary, expands on tap to the full
 * per-day open/close timeline. */
function HoursTimeline({ dates, dateHours }: { dates: string[]; dateHours: Record<string, DateHours> }) {
  const [open, setOpen] = useState(false);
  const shortDays = dates.filter((d) => {
    const h = dateHours[d]?.hours_open;
    return h != null && h < 8;
  }).length;

  return (
    <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2.5 py-2">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-soft">{open ? "▾" : "▸"} Shop hours</span>
        <span className={`font-mono text-[9px] ${shortDays > 0 ? "font-semibold text-chili-deep" : "text-ink-soft"}`}>
          {shortDays > 0 ? `${shortDays} short day${shortDays === 1 ? "" : "s"}` : "all normal"}
        </span>
      </button>
      {open && (
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
                <span className={`w-9 shrink-0 font-mono text-[9px] ${isWeekendDay(d) ? "font-semibold text-gold-deep" : "text-ink-soft"}`}>
                  {fmtDay(d)}{weekdayLetter(d)}
                </span>
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
      )}
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

/** Combined bar + line chart on a shared scale: bars are units sold, colored
 * by that day's stock context (orange ✕ = out of stock, green = sold out —
 * demand met or beat supply, blue = a normal day with stock left over); the
 * connected orange line is that day's raw stock — day-start reading plus
 * any approved stock-in received that same day (daily_stock).
 * Fixed pixel columns (not percentage widths) so it scrolls as one block
 * alongside the day labels for wide date ranges. Pure SVG for the line — no
 * charting library needed.
 *
 * Every column is a tap target (not just hover, which doesn't exist on
 * mobile) — tapping a day highlights it and prints its exact sold/stock
 * numbers below the chart, since bar height and line position alone can't
 * be read precisely by eye. Defaults to the most recent day so a number is
 * visible before the user taps anything. */
function ComboChart({ dates, daily, dailyStock }: { dates: string[]; daily: Record<string, number>; dailyStock: Record<string, number | null> }) {
  const [selected, setSelected] = useState<number | null>(dates.length > 0 ? dates.length - 1 : null);
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
    <div>
      <div className="overflow-x-auto">
        <div className="relative" style={{ width, height: TOP_LABEL_H + CHART_H + BOTTOM_LABEL_H }}>
          <div className="absolute inset-x-0 top-0 flex gap-1" style={{ height: TOP_LABEL_H }}>
            {soldValues.map((v, i) => {
              const outOfStock = stockValues[i] === 0;
              return (
                <span
                  key={i}
                  style={{ width: COL_W }}
                  className={`shrink-0 text-center font-mono text-[8px] font-semibold leading-none ${outOfStock ? "text-chili-deep" : "text-ink"}`}
                >
                  {outOfStock ? "✕" : v > 0 ? v : ""}
                </span>
              );
            })}
          </div>
          <div className="absolute inset-x-0 flex items-end gap-1" style={{ top: TOP_LABEL_H, height: CHART_H }}>
            {soldValues.map((v, i) => {
              const stock = stockValues[i];
              const outOfStock = stock === 0;
              const soldOut = stock !== null && stock > 0 && v >= stock;
              const barColor = outOfStock ? "bg-chili/50" : soldOut ? "bg-leaf/70" : v === 0 ? "bg-ink-soft/15" : "bg-chrome/60";
              return (
                <div
                  key={i}
                  style={{ width: COL_W, height: v === 0 || outOfStock ? 3 : Math.max(4, (v / max) * CHART_H) }}
                  className={`shrink-0 rounded-sm ${barColor}`}
                />
              );
            })}
          </div>
          {points.length > 0 && (
            <svg className="absolute left-0" style={{ top: TOP_LABEL_H, width, height: CHART_H, overflow: "visible" }}>
              <polyline points={linePoints} fill="none" stroke="#C9601C" strokeWidth={1.5} />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2.2} fill="#C9601C" stroke="#fffdf7" strokeWidth={1} />
              ))}
            </svg>
          )}
          {/* Weekday letter + day-of-month, stacked — Fri/Sat (Dhaka's
              weekend) colored so the weekly pattern is visible at a glance. */}
          <div className="absolute inset-x-0 flex flex-col gap-0.5" style={{ top: TOP_LABEL_H + CHART_H, height: BOTTOM_LABEL_H }}>
            <div className="flex gap-1">
              {dates.map((d, i) => (
                <span
                  key={i}
                  style={{ width: COL_W }}
                  className={`shrink-0 text-center font-mono text-[8px] font-semibold leading-none ${
                    selected === i ? "text-chrome" : isWeekendDay(d) ? "text-gold-deep" : "text-ink-soft/60"
                  }`}
                >
                  {weekdayLetter(d)}
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              {dates.map((d, i) => (
                <span
                  key={i}
                  style={{ width: COL_W }}
                  className={`shrink-0 text-center font-mono text-[8px] leading-none ${selected === i ? "font-bold text-chrome" : "text-ink-soft/70"}`}
                >
                  {fmtDay(d)}
                </span>
              ))}
            </div>
          </div>
          {/* Tap targets — one per day, spanning the full chart height, on
              top of everything else. Transparent except a highlight tint on
              the selected column, so the bars/line/labels underneath stay visible. */}
          <div className="absolute inset-x-0 top-0 flex gap-1" style={{ height: TOP_LABEL_H + CHART_H + BOTTOM_LABEL_H }}>
            {dates.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                style={{ width: COL_W }}
                className={`shrink-0 rounded-sm ${selected === i ? "bg-chrome/15" : "active:bg-chrome/10"}`}
                aria-label={`${weekdayShort(dates[i])} ${dates[i]}: sold ${soldValues[i]}${stockValues[i] === null ? "" : `, stock ${stockValues[i]}`}`}
              />
            ))}
          </div>
        </div>
      </div>
      {selected !== null && (
        <div className="mt-1.5 flex items-center gap-3 rounded bg-paper-dim px-2 py-1.5 font-mono text-[10.5px]">
          <span className="font-semibold text-ink">
            {shortDate(dates[selected])}{" "}
            <span className={isWeekendDay(dates[selected]) ? "text-gold-deep" : "text-ink-soft"}>
              ({weekdayShort(dates[selected])})
            </span>
          </span>
          <span className="text-ink-soft">
            Sold <span className="font-semibold text-ink">{soldValues[selected]}</span>
          </span>
          <span className="text-ink-soft">
            Stock{" "}
            <span className={`font-semibold ${stockValues[selected] === 0 ? "text-chili-deep" : "text-ink"}`}>
              {stockValues[selected] === null ? "no data" : stockValues[selected]}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Per-ingredient breakdown of the card's "makeable now" number — only shown
 * when there's actually more than one ingredient to compare (a single
 * ingredient's figure is already fully explained by the header's pack
 * note). How to read it is covered once in the page-level intro, not
 * repeated here per card.
 */
function IngredientBreakdown({ productId, productName, outlet }: { productId: number; productName: string; outlet: number }) {
  const [detail, setDetail] = useState<ProductStockDetail | null>(null);

  useEffect(() => {
    api<ProductStockDetail>(`/reports/product-stock-detail/?outlet=${outlet}&product=${productId}`).then(setDetail);
  }, [productId, outlet]);

  // Packaging/supply ingredients (bamboo sticks, sauce sachets) never limit
  // this figure — they're tracked separately in Packaging & Supplies.
  const realIngredients = (detail?.ingredients ?? []).filter((ing) => !ing.is_periodic);
  if (realIngredients.length < 2) return null;

  return (
    <div className="flex flex-col gap-1 border-t border-dotted border-[#d8cdb0] pt-2 font-mono text-[11px]">
      {realIngredients.map((ing) => {
        const note = packBreakdown(ing.quantity_available, ing.pieces_per_pack, ing.base_unit);
        return (
          <div key={ing.ingredient_id} className={`flex flex-col gap-0.5 ${ing.is_bottleneck ? "text-chili-deep font-semibold" : ""}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate">{ing.ingredient_name}</span>
              {ing.is_bottleneck && <span className="shrink-0">← limit</span>}
            </div>
            <div className="font-normal text-ink-soft">
              → {ing.pieces_possible} {productName} ({ing.quantity_available} {ing.base_unit}{note ? ` = ${note}` : ""})
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded bg-paper-dim px-2.5 py-1">
      <span className="font-mono text-[8px] uppercase tracking-wide text-ink-soft">{label}</span>
      <span className="font-mono text-[12.5px] font-semibold leading-tight text-ink">{value}</span>
    </div>
  );
}

/**
 * The card design: a name + current-makeable-stock header (the number
 * that matters most at a glance), a two-stat summary strip (total sold,
 * and demand-adjusted average — the number that actually answers "should I
 * order more"), and an out-of-stock badge only when it's relevant, instead
 * of a full date-by-date breakdown that only makes sense once you're already
 * looking for something specific. That detail lives one tap away.
 */
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
  const stats = useMemo(() => summaryStats(row, dates), [row, dates]);

  return (
    <div className={`rounded border bg-[#fffdf7] px-2.5 py-2 ${isOpen ? "border-chrome" : "border-[#d8cdb0]"}`}>
      <button className="w-full text-left" onClick={() => onToggle(row.id)}>
        <div className="flex items-start justify-between gap-2">
          <span className="truncate font-mono text-[12.5px] font-semibold leading-tight">
            {isOpen ? "▾" : "▸"} {row.name}
          </span>
          <div className="shrink-0 text-right leading-none">
            <div className={`font-mono text-[15px] font-bold ${stockColor(row.stock)}`}>
              {row.stock === null ? "—" : row.stock}
            </div>
            <div className="mt-0.5 font-mono text-[7.5px] uppercase tracking-wide text-ink-soft/60">makeable now</div>
            {stockPackNote(row.stock_pack) && (
              <div className="mt-0.5 font-mono text-[8px] text-ink-soft/70">{stockPackNote(row.stock_pack)}</div>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <SummaryChip label="Sold" value={String(row.total)} />
          <SummaryChip label="Avg/day" value={stats.avgPerDayInStock === null ? "—" : stats.avgPerDayInStock.toFixed(1)} />
          {stats.stockoutDays > 0 && (
            <span className="ml-auto shrink-0 self-center rounded-full bg-chili/15 px-2 py-1 font-mono text-[9px] font-semibold text-chili-deep">
              ⚠ {stats.stockoutDays}d out of stock
            </span>
          )}
        </div>
      </button>
      {isOpen && (
        <div className="mt-2.5 flex flex-col gap-2 border-t border-dotted border-[#d8cdb0] pt-2.5">
          <ComboChart dates={dates} daily={row.daily} dailyStock={row.daily_stock} />
          <IngredientBreakdown productId={row.id} productName={row.name} outlet={outlet} />
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
        <td className="text-right">
          <div className={`num font-semibold ${stockColor(row.stock)}`}>{row.stock === null ? "—" : row.stock}</div>
          {stockPackNote(row.stock_pack) && (
            <div className="font-mono text-[9px] font-normal text-ink-soft/60">{stockPackNote(row.stock_pack)}</div>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={dates.length + 4} className="bg-paper-dim !border-b !border-dotted !border-[#d8cdb0]">
            <IngredientBreakdown productId={row.id} productName={row.name} outlet={outlet} />
          </td>
        </tr>
      )}
    </>
  );
}
