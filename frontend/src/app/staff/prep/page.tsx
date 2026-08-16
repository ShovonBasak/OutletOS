"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, timeOf, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import { PRODUCT_CATEGORIES } from "@/lib/types";
import type { Paginated, PrepLog, PrepProduct, RawStockSlim, DisplayStockSlim } from "@/lib/types";

// ---- per-product prep memory (localStorage) ----
const PREP_MEMORY_KEY = "cp_prep_memory";
type PrepMemoryEntry = { unit: "PACK" | "PIECE"; value: number };

function loadPrepMemory(): Record<number, PrepMemoryEntry> {
  try {
    return JSON.parse(localStorage.getItem(PREP_MEMORY_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrepMemory(productId: number, unit: "PACK" | "PIECE", value: number) {
  const mem = loadPrepMemory();
  mem[productId] = { unit, value };
  localStorage.setItem(PREP_MEMORY_KEY, JSON.stringify(mem));
}

/** Max whole pieces that can be prepared given current raw + component stock. */
function maxPreparablePieces(
  product: PrepProduct,
  rawByIngredient: Map<number, RawStockSlim>,
  displayByProduct: Map<number, DisplayStockSlim>,
): number {
  if (product.recipes.length === 0 && product.product_recipe_components.length === 0) return 0;
  let cap = Infinity;
  for (const r of product.recipes) {
    const rs = rawByIngredient.get(r.ingredient);
    const available = rs ? Number(rs.quantity_available) : 0;
    const perPiece = Number(r.quantity_per_unit);
    if (perPiece > 0) cap = Math.min(cap, Math.floor(available / perPiece));
  }
  for (const c of product.product_recipe_components) {
    const ds = displayByProduct.get(c.component_product);
    const available = ds ? ds.pieces_available : 0;
    const perPiece = Number(c.quantity_per_unit);
    if (perPiece > 0) cap = Math.min(cap, Math.floor(available / perPiece));
  }
  return cap === Infinity ? 0 : Math.max(0, cap);
}

/** Returns the primary recipe row: explicit is_primary flag, or the only recipe for single-ingredient products. */
function primaryRecipe(product: PrepProduct): PrepProduct["recipes"][0] | null {
  return product.recipes.find((r) => r.is_primary) ?? (product.recipes.length === 1 ? product.recipes[0] : null);
}

/** Max whole packs that can be used, based on the primary ingredient and all supporting ingredients. */
function maxPreparablePacks(
  product: PrepProduct,
  rawByIngredient: Map<number, RawStockSlim>,
): number {
  const primary = primaryRecipe(product);
  if (!primary) return 0;
  const rs = rawByIngredient.get(primary.ingredient);
  if (!rs) return 0;
  const piecesPerPack = Number(rs.pieces_per_pack);
  if (!piecesPerPack || piecesPerPack <= 0) return 0;

  // Pieces produced per pack = piecesPerPack / primary.quantity_per_unit
  const primaryQtyPerUnit = Number(primary.quantity_per_unit) || 1;
  const piecesPerPackProduced = piecesPerPack / primaryQtyPerUnit;

  // Start from primary ingredient's own stock
  let maxPacks = Math.floor(Number(rs.quantity_available) / piecesPerPack);

  // Limit by each supporting ingredient
  for (const r of product.recipes) {
    if (r.id === primary.id) continue;
    const otherRs = rawByIngredient.get(r.ingredient);
    const available = otherRs ? Number(otherRs.quantity_available) : 0;
    const perUnit = Number(r.quantity_per_unit);
    if (perUnit <= 0) continue;
    // packs * piecesPerPackProduced * perUnit <= available
    const maxPacksFromThis = Math.floor(available / (piecesPerPackProduced * perUnit));
    maxPacks = Math.min(maxPacks, maxPacksFromThis);
  }

  return Math.max(0, maxPacks);
}

export default function PrepPage() {
  const { user } = useAuth();
  const { day, workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [allProducts, setAllProducts] = useState<PrepProduct[]>([]);
  const [logs, setLogs] = useState<PrepLog[]>([]);
  const [allLogs, setAllLogs] = useState<PrepLog[]>([]);
  const [raw, setRaw] = useState<RawStockSlim[]>([]);
  const [displayStock, setDisplayStock] = useState<DisplayStockSlim[]>([]);

  const prevCtx = useRef({ outlet: 0, opDate: "" });

  const [productId, setProductId] = useState<number | "">("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [unit, setUnit] = useState<"PACK" | "PIECE">("PIECE");
  const [packs, setPacks] = useState(1);
  const [pieces, setPieces] = useState(1);
  const [msg, setMsg] = useState("");

  const rawByIngredient = useMemo(() => {
    const m = new Map<number, RawStockSlim>();
    raw.forEach((r) => m.set(r.ingredient, r));
    return m;
  }, [raw]);

  const displayByProduct = useMemo(() => {
    const m = new Map<number, DisplayStockSlim>();
    displayStock.forEach((d) => m.set(d.product, d));
    return m;
  }, [displayStock]);

  const priceByProduct = useMemo(() => {
    const m = new Map<number, number>();
    allProducts.forEach((p) => m.set(p.id, Number(p.selling_price) || 0));
    return m;
  }, [allProducts]);

  // "Ready to sell" is derived from today's prep logs (FRESH + CARRIED_FORWARD),
  // not DisplayStock, so it reflects only what was prepared/carried on this op_date.
  const readyByProduct = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of allLogs) {
      m.set(l.product, (m.get(l.product) ?? 0) + l.pieces_prepared);
    }
    return m;
  }, [allLogs]);

  const preparedToday = useMemo(() => {
    return Array.from(readyByProduct.entries())
      .filter(([, pcs]) => pcs > 0)
      .map(([productId, pcs]) => {
        const prod = allProducts.find((p) => p.id === productId);
        return prod ? { product: productId, product_name: prod.name, pieces: pcs } : null;
      })
      .filter(Boolean) as { product: number; product_name: string; pieces: number }[];
  }, [readyByProduct, allProducts]);

  const readyPieces = useMemo(
    () => Array.from(readyByProduct.values()).reduce((s, v) => s + v, 0),
    [readyByProduct],
  );

  const readyValue = useMemo(
    () => preparedToday.reduce((s, d) => s + d.pieces * (priceByProduct.get(d.product) ?? 0), 0),
    [preparedToday, priceByProduct],
  );

  // Products with enough stock to prepare at least 1 piece.
  const products = useMemo(
    () => allProducts.filter((p) => maxPreparablePieces(p, rawByIngredient, displayByProduct) >= 1),
    [allProducts, rawByIngredient, displayByProduct],
  );

  async function loadStatic() {
    const p = await api<Paginated<PrepProduct>>(
      `/products/?as_of=${opDate}&prep=1`
    );
    setAllProducts(p.results);
  }

  async function loadLive() {
    const [l, rs, ds] = await Promise.all([
      api<Paginated<PrepLog>>(`/preparation-logs/?outlet=${outlet}&date=${opDate}&slim=1`),
      api<Paginated<RawStockSlim>>(`/raw-stock/?outlet=${outlet}&slim=1`),
      api<Paginated<DisplayStockSlim>>(`/display-stock/?outlet=${outlet}&slim=1`),
    ]);
    setAllLogs(l.results);
    setLogs(l.results.filter((x) => x.source === "FRESH"));
    setRaw(rs.results);
    setDisplayStock(ds.results);
  }

  useEffect(() => {
    if (prevCtx.current.outlet === outlet && prevCtx.current.opDate === opDate) return;
    prevCtx.current = { outlet, opDate };
    loadStatic();
    loadLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet, opDate]);

  // Auto-select first available product when the list loads or changes.
  useEffect(() => {
    if (productId === "" && products[0]) {
      setProductId(products[0].id);
    } else if (productId !== "" && !products.find((p) => p.id === productId)) {
      setProductId(products[0]?.id ?? "");
    }
  }, [products, productId]);

  const product = allProducts.find((p) => p.id === productId);
  const primary = product ? primaryRecipe(product) : null;
  const canUsePack = !!primary;

  const maxPieces = product ? maxPreparablePieces(product, rawByIngredient, displayByProduct) : 0;
  const maxPacks = product ? maxPreparablePacks(product, rawByIngredient) : 0;

  // Restore last-used unit + quantity when the selected product changes.
  useEffect(() => {
    if (productId === "") return;
    const saved = loadPrepMemory()[productId];
    if (saved) {
      setUnit(saved.unit);
      if (saved.unit === "PACK") setPacks(saved.value);
      else setPieces(saved.value);
    }
  }, [productId]);

  // When product changes, clamp current values to new limits.
  useEffect(() => {
    if (maxPieces > 0) setPieces((prev) => Math.min(prev, maxPieces) || 1);
  }, [maxPieces]);
  useEffect(() => {
    if (maxPacks > 0) setPacks((prev) => Math.min(prev, maxPacks) || 1);
  }, [maxPacks]);

  // Reset to PIECE when the selected product doesn't support PACK.
  useEffect(() => {
    if (!canUsePack && unit === "PACK") setUnit("PIECE");
  }, [canUsePack, unit]);

  async function logBatch() {
    if (productId === "") return;
    setMsg("");
    try {
      await api("/preparation-logs/", {
        method: "POST",
        body: JSON.stringify({
          outlet,
          product: productId,
          source: "FRESH",
          op_date: opDate,
          prep_unit: unit,
          packs_used: unit === "PACK" ? packs : null,
          pieces_prepared: unit === "PIECE" ? pieces : 0,
        }),
      });
      savePrepMemory(productId, unit, unit === "PACK" ? packs : pieces);
      setMsg("Logged ✓");
      loadLive();
    } catch {
      setMsg("Failed — not enough raw stock, or no pack for the ingredient.");
    }
  }

  const canLog = products.length > 0 && productId !== "" && (unit === "PIECE" ? pieces <= maxPieces : packs <= maxPacks);

  if (day === null) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <h1 className="font-display text-xl font-bold">Preparation log</h1>
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      </div>
    );
  }

  if (day.status === "CLOSED") {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <h1 className="font-display text-xl font-bold">Preparation log</h1>
        <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3 font-mono text-xs text-ink-soft">
          🔒 Today&apos;s day is closed. Preparation logging is not available until the next day starts.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Preparation log</h1>
        <p className="text-xs text-ink-soft">Fresh prep · real-time (no approval)</p>
      </div>

      <div className="rounded bg-paper-dim px-3 py-2.5">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wide text-ink-soft">Ready to sell</span>
          <span className="num font-semibold">{readyPieces} pcs</span>
        </div>
        {readyValue > 0 && (
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-[10px] text-ink-soft">Total value</span>
            <span className="num font-bold text-leaf-deep">{bdt(readyValue)}</span>
          </div>
        )}
        {preparedToday.length === 0 ? (
          <p className="font-mono text-[11px] text-ink-soft">Nothing prepared yet.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {preparedToday.map((d) => {
                const price = priceByProduct.get(d.product) ?? 0;
                return (
                  <div key={d.product} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink truncate">{d.product_name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                      {d.pieces} pcs
                      {price > 0 && <span className="ml-1.5 text-ink">= {bdt(d.pieces * price)}</span>}
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {products.length === 0 ? (
        <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3 font-mono text-xs text-ink-soft">
          No products have enough stock to prepare right now.
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="field-label">Product</span>
            <button
              ref={triggerRef}
              type="button"
              className="field-input flex items-center justify-between text-left"
              onClick={() => setPickerOpen(true)}
            >
              <span className={product ? "text-ink" : "text-ink-soft"}>
                {product ? product.name : "Select a product…"}
              </span>
              <span className="font-mono text-[11px] text-ink-soft">▾</span>
            </button>
          </div>

          <ProductPickerSheet
            isOpen={pickerOpen}
            onClose={() => setPickerOpen(false)}
            products={products}
            selectedId={productId}
            onSelect={(id) => { setProductId(id); setPickerOpen(false); }}
            maxPieces={(p) => maxPreparablePieces(p, rawByIngredient, displayByProduct)}
            triggerRef={triggerRef}
          />

          {/* Stock breakdown for selected product */}
          {product && (
            <div className="ticket flex flex-col gap-2">
              {product.recipes.length > 0 && (
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Raw ingredients · per piece</p>
                  {product.recipes.map((r) => {
                    const rs = rawByIngredient.get(r.ingredient);
                    const available = rs ? Number(rs.quantity_available) : 0;
                    const canMake = Number(r.quantity_per_unit) > 0
                      ? Math.floor(available / Number(r.quantity_per_unit))
                      : 0;
                    return (
                      <div key={r.id} className="ticket-row">
                        <span>{rs?.ingredient_display_name ?? r.ingredient_name} · {r.quantity_per_unit} {r.base_unit}</span>
                        <span className="qty text-ink-soft">
                          {available} {rs?.base_unit ?? ""} → {canMake} pcs
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {product.product_recipe_components.length > 0 && (
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Derived from · per piece</p>
                  {product.product_recipe_components.map((c) => {
                    const ds = displayByProduct.get(c.component_product);
                    const available = ds?.pieces_available ?? 0;
                    const need = unit === "PIECE"
                      ? Number(c.quantity_per_unit) * pieces
                      : Number(c.quantity_per_unit) * packs;
                    const short = available < need;
                    return (
                      <div key={c.id} className="ticket-row">
                        <span>{c.component_name} · {c.quantity_per_unit} pcs</span>
                        <span className={`qty ${short ? "text-chili font-semibold" : "text-ink-soft"}`}>
                          {available} pcs ready{short ? " ⚠ short" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            {(["PIECE", "PACK"] as const).map((u) => {
              const disabled = u === "PACK" && !canUsePack;
              return (
                <button
                  key={u}
                  disabled={disabled}
                  className={`chip ${unit === u ? "chip-active" : ""} ${disabled ? "opacity-30" : ""}`}
                  onClick={() => setUnit(u)}
                  title={disabled ? "Mark a primary ingredient in the recipe editor to enable pack mode" : undefined}
                >
                  By {u.toLowerCase()}
                </button>
              );
            })}
          </div>
          {!canUsePack ? (
            <p className="font-mono text-[10px] text-ink-soft">
              Multi-ingredient — no primary set. Log finished pieces; all ingredients deducted per recipe.
            </p>
          ) : primary && product && product.recipes.length > 1 && (
            <p className="font-mono text-[10px] text-ink-soft">
              Pack size based on <span className="font-semibold">{primary.ingredient_name}</span> — supporting ingredients deducted proportionally.
            </p>
          )}

          {unit === "PACK" ? (
            <Stepper
              label="Packs used"
              value={packs}
              setValue={setPacks}
              step={0.5}
              min={0.5}
              max={maxPacks || Infinity}
            />
          ) : (
            <Stepper
              label="Pieces prepared"
              value={pieces}
              setValue={setPieces}
              step={1}
              min={1}
              max={maxPieces}
            />
          )}

          <button className="btn btn-primary" disabled={!canLog} onClick={logBatch}>
            Log prep batch
          </button>
          {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}
        </>
      )}

      <div>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Today&apos;s fresh entries
        </p>
        {logs.length === 0 && <p className="font-mono text-xs text-ink-soft">No entries yet.</p>}
        {logs.map((l) => (
          <div
            key={l.id}
            className="flex items-center justify-between border-b border-dotted border-[#d8cdb0] py-1.5 font-mono text-[11px] text-ink-soft"
          >
            <span>{timeOf(l.timestamp)} · {l.product_name}</span>
            <span className="flex items-center gap-2">
              <span>
                {l.prep_unit === "PACK" ? `${l.packs_used} pack` : "manual"} → {l.pieces_prepared} pcs
              </span>
              <button
                className="text-chili opacity-60 hover:opacity-100"
                title="Delete and revert stock"
                onClick={async () => {
                  if (!confirm("Delete this entry? Stock will be restored.")) return;
                  try {
                    await api(`/preparation-logs/${l.id}/`, { method: "DELETE" });
                    loadLive();
                  } catch (err) {
                    const body = (err as { body?: { detail?: string } })?.body;
                    alert(body?.detail ?? "Could not delete prep log. Please try again.");
                  }
                }}
              >
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>

      <Link href="/staff/prep/carry-forward" className="btn btn-ghost text-center">
        Carry-forward from yesterday
      </Link>
    </div>
  );
}

type PickerPos = { top: number; left: number; width: number; maxH: number };

function ProductPickerSheet({
  isOpen,
  onClose,
  products,
  selectedId,
  onSelect,
  maxPieces,
  triggerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  products: PrepProduct[];
  selectedId: number | "";
  onSelect: (id: number) => void;
  maxPieces: (p: PrepProduct) => number;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<PickerPos | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const GAP = 4;
        const MARGIN = 16;
        const maxViewH = window.innerHeight * 0.7;
        const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
        const spaceAbove = rect.top - MARGIN;
        if (spaceBelow >= 160 || spaceBelow >= spaceAbove) {
          setPos({ top: rect.bottom + GAP, left: rect.left, width: rect.width, maxH: Math.min(spaceBelow, maxViewH) });
        } else {
          const maxH = Math.min(spaceAbove, maxViewH);
          setPos({ top: rect.top - maxH - GAP, left: rect.left, width: rect.width, maxH });
        }
      }
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen, triggerRef]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  }, [products, search]);

  // Group by category — only show headers if 2+ distinct categories.
  const groups = useMemo(() => {
    const map = new Map<string, PrepProduct[]>();
    filtered.forEach((p) => {
      const cat = p.category || "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    });
    const order = (cat: string) => {
      const i = PRODUCT_CATEGORIES.indexOf(cat as never);
      return i === -1 ? 999 : i;
    };
    return [...map.entries()].sort(([a], [b]) => order(a) - order(b));
  }, [filtered]);
  const showCategories = groups.length > 1;

  if (!isOpen || !pos) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {/* light backdrop so tapping outside closes */}
      <div className="absolute inset-0 bg-ink/20" />

      {/* dropdown panel anchored to trigger */}
      <div
        className="absolute flex flex-col overflow-hidden rounded-xl border border-[#d8cdb0] bg-paper shadow-xl"
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* search */}
        <div className="border-b border-[#d8cdb0] px-3 py-2">
          <input
            ref={inputRef}
            className="field-input w-full"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* list */}
        <div className="overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No matches.</p>
          )}
          {groups.map(([cat, items]) => (
            <div key={cat}>
              {showCategories && (
                <p className="sticky top-0 bg-paper px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
                  {cat}
                </p>
              )}
              {items.map((p) => {
                const max = maxPieces(p);
                const isSelected = p.id === selectedId;
                const pillColor =
                  max <= 3
                    ? "bg-chili/15 text-chili"
                    : max <= 9
                    ? "bg-gold/20 text-gold-deep"
                    : "bg-leaf/15 text-leaf-deep";
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`flex w-full items-center justify-between border-b border-dotted border-[#d8cdb0] px-4 py-3 text-left transition-colors active:bg-paper-dim ${
                      isSelected ? "bg-action/10" : ""
                    }`}
                    onClick={() => onSelect(p.id)}
                  >
                    <span className={`font-mono text-sm ${isSelected ? "font-semibold text-ink" : "text-ink"}`}>
                      {p.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${pillColor}`}>
                        max {max}
                      </span>
                      {isSelected && (
                        <span className="font-mono text-[11px] text-chrome">✓</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
          {/* bottom safe area */}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  setValue,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  setValue: (n: number) => void;
  step: number;
  min: number;
  max: number;
}) {
  const [draft, setDraft] = useState(String(value));

  // Keep draft in sync when value changes from outside (e.g. product switch).
  useEffect(() => { setDraft(String(value)); }, [value]);

  function commit(raw: string) {
    const parsed = step < 1 ? parseFloat(raw) : parseInt(raw, 10);
    if (!isNaN(parsed)) {
      const clamped = +(Math.min(max, Math.max(min, parsed)).toFixed(2));
      setValue(clamped);
      setDraft(String(clamped));
    } else {
      setDraft(String(value));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="field-label">{label}</span>
        {max !== Infinity && (
          <span className="font-mono text-[10px] text-ink-soft">max {max}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          className="h-8 w-8 shrink-0 rounded-full border border-ink font-mono disabled:opacity-30"
          disabled={value <= min}
          onClick={() => {
            const next = +(Math.max(min, value - step).toFixed(2));
            setValue(next);
            setDraft(String(next));
          }}
        >
          −
        </button>
        <input
          className={`field-input w-20 text-center font-mono text-base ${value > max ? "border-chili text-chili" : ""}`}
          inputMode={step < 1 ? "decimal" : "numeric"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(draft); }}
        />
        <button
          className="h-8 w-8 shrink-0 rounded-full border border-ink font-mono disabled:opacity-30"
          disabled={value >= max}
          onClick={() => {
            const next = +(Math.min(max, value + step).toFixed(2));
            setValue(next);
            setDraft(String(next));
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}
