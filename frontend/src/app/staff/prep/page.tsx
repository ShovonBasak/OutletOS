"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, timeOf, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import type { Paginated, PreparationLog, Product, RawStock, DisplayStock } from "@/lib/types";

/** Max whole pieces that can be prepared given current raw + component stock. */
function maxPreparablePieces(
  product: Product,
  rawByIngredient: Map<number, RawStock>,
  displayByProduct: Map<number, DisplayStock>,
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
function primaryRecipe(product: Product): Product["recipes"][0] | null {
  return product.recipes.find((r) => r.is_primary) ?? (product.recipes.length === 1 ? product.recipes[0] : null);
}

/** Max whole packs that can be used, based on the primary ingredient and all supporting ingredients. */
function maxPreparablePacks(
  product: Product,
  rawByIngredient: Map<number, RawStock>,
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
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [logs, setLogs] = useState<PreparationLog[]>([]);
  const [raw, setRaw] = useState<RawStock[]>([]);
  const [displayStock, setDisplayStock] = useState<DisplayStock[]>([]);
  const [readyPieces, setReadyPieces] = useState(0);

  const [productId, setProductId] = useState<number | "">("");
  const [unit, setUnit] = useState<"PACK" | "PIECE">("PIECE");
  const [packs, setPacks] = useState(1);
  const [pieces, setPieces] = useState(1);
  const [msg, setMsg] = useState("");

  const rawByIngredient = useMemo(() => {
    const m = new Map<number, RawStock>();
    raw.forEach((r) => m.set(r.ingredient, r));
    return m;
  }, [raw]);

  const displayByProduct = useMemo(() => {
    const m = new Map<number, DisplayStock>();
    displayStock.forEach((d) => m.set(d.product, d));
    return m;
  }, [displayStock]);

  const priceByProduct = useMemo(() => {
    const m = new Map<number, number>();
    allProducts.forEach((p) => m.set(p.id, Number(p.selling_price) || 0));
    return m;
  }, [allProducts]);

  const readyValue = useMemo(
    () => displayStock.reduce((sum, d) => sum + d.pieces_available * (priceByProduct.get(d.product) ?? 0), 0),
    [displayStock, priceByProduct],
  );

  // Products with enough stock to prepare at least 1 piece.
  const products = useMemo(
    () => allProducts.filter((p) => maxPreparablePieces(p, rawByIngredient, displayByProduct) >= 1),
    [allProducts, rawByIngredient, displayByProduct],
  );

  async function refresh() {
    const [p, l, rs, ds] = await Promise.all([
      api<Paginated<Product>>(`/products/?active=true&product_type=SINGLE&as_of=${opDate}`),
      api<Paginated<PreparationLog>>(`/preparation-logs/?outlet=${outlet}&date=${opDate}`),
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
      api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
    ]);
    setAllProducts(p.results.filter((x) => x.requires_preparation));
    setLogs(l.results.filter((x) => x.source === "FRESH"));
    setRaw(rs.results);
    setDisplayStock(ds.results);
    setReadyPieces(ds.results.reduce((s, r) => s + r.pieces_available, 0));
  }

  useEffect(() => {
    refresh();
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
      setMsg("Logged ✓");
      refresh();
    } catch {
      setMsg("Failed — not enough raw stock, or no pack for the ingredient.");
    }
  }

  const canLog = products.length > 0 && productId !== "" && (unit === "PIECE" ? pieces <= maxPieces : packs <= maxPacks);

  if (day?.status === "CLOSED") {
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
        {displayStock.filter((d) => d.pieces_available > 0).length === 0 ? (
          <p className="font-mono text-[11px] text-ink-soft">Nothing prepared yet.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {displayStock
              .filter((d) => d.pieces_available > 0)
              .map((d) => {
                const price = priceByProduct.get(d.product) ?? 0;
                return (
                  <div key={d.id} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink truncate">{d.product_name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                      {d.pieces_available} pcs
                      {price > 0 && <span className="ml-1.5 text-ink">= {bdt(d.pieces_available * price)}</span>}
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
          <label className="flex flex-col gap-1">
            <span className="field-label">Product</span>
            <select
              className="field-input"
              value={productId}
              onChange={(e) => setProductId(Number(e.target.value))}
            >
              {products.map((p) => {
                const max = maxPreparablePieces(p, rawByIngredient, displayByProduct);
                return (
                  <option key={p.id} value={p.id}>
                    {p.name} (max {max} pcs)
                  </option>
                );
              })}
            </select>
          </label>

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
                        <span>{r.ingredient_name} · {r.quantity_per_unit} {r.base_unit}</span>
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
                  await api(`/preparation-logs/${l.id}/`, { method: "DELETE" });
                  refresh();
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
