"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { timeOf } from "@/lib/format";
import type { Paginated, PreparationLog, Product, RawStock, DisplayStock } from "@/lib/types";

export default function PrepPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const [products, setProducts] = useState<Product[]>([]);
  const [logs, setLogs] = useState<PreparationLog[]>([]);
  const [raw, setRaw] = useState<RawStock[]>([]);
  const [readyPieces, setReadyPieces] = useState(0);

  const [productId, setProductId] = useState<number | "">("");
  const [unit, setUnit] = useState<"PACK" | "PIECE">("PIECE");
  const [packs, setPacks] = useState(1);
  const [pieces, setPieces] = useState(10);
  const [msg, setMsg] = useState("");

  async function refresh() {
    const [p, l, rs, ds] = await Promise.all([
      api<Paginated<Product>>("/products/?active=true&product_type=SINGLE"),
      api<Paginated<PreparationLog>>(`/preparation-logs/?outlet=${outlet}&today=true`),
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
      api<Paginated<DisplayStock>>(`/display-stock/?outlet=${outlet}`),
    ]);
    const prep = p.results.filter((x) => x.requires_preparation);
    setProducts(prep);
    if (productId === "" && prep[0]) setProductId(prep[0].id);
    setLogs(l.results.filter((x) => x.source === "FRESH"));
    setRaw(rs.results);
    setReadyPieces(ds.results.reduce((s, r) => s + r.pieces_available, 0));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet]);

  const product = products.find((p) => p.id === productId);
  const singleIngredient = (product?.recipes.length ?? 0) === 1;

  // PACK is only valid for a single-ingredient recipe (per the data model).
  useEffect(() => {
    if (!singleIngredient && unit === "PACK") setUnit("PIECE");
  }, [singleIngredient, unit]);

  const rawByIngredient = useMemo(() => {
    const m = new Map<number, RawStock>();
    raw.forEach((r) => m.set(r.ingredient, r));
    return m;
  }, [raw]);

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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Preparation log</h1>
        <p className="text-xs text-ink-soft">Fresh prep · real-time (no approval)</p>
      </div>

      <div className="rounded bg-paper-dim px-3 py-2.5">
        <div className="num text-lg font-semibold">{readyPieces}</div>
        <div className="text-[10px] uppercase tracking-wide text-ink-soft">Ready pieces to sell</div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="field-label">Product</span>
        <select
          className="field-input"
          value={productId}
          onChange={(e) => setProductId(Number(e.target.value))}
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {/* Recipe ingredients + their current raw stock */}
      {product && (
        <div className="ticket">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-soft">Uses per piece</p>
          {product.recipes.map((r) => {
            const rs = rawByIngredient.get(r.ingredient);
            return (
              <div key={r.id} className="ticket-row">
                <span>
                  {r.ingredient_name} · {r.quantity_per_unit} {r.base_unit}
                </span>
                <span className="qty text-ink-soft">
                  {rs ? `${rs.quantity_available} ${rs.base_unit} left` : "no stock"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        {(["PIECE", "PACK"] as const).map((u) => {
          const disabled = u === "PACK" && !singleIngredient;
          return (
            <button
              key={u}
              disabled={disabled}
              className={`chip ${unit === u ? "chip-active" : ""} ${disabled ? "opacity-30" : ""}`}
              onClick={() => setUnit(u)}
              title={disabled ? "PACK only for single-ingredient items" : undefined}
            >
              By {u.toLowerCase()}
            </button>
          );
        })}
      </div>
      {!singleIngredient && (
        <p className="font-mono text-[10px] text-ink-soft">
          Multi-ingredient item — log finished pieces; ingredients are deducted per recipe.
        </p>
      )}

      {unit === "PACK" ? (
        <Stepper label="Packs used" value={packs} setValue={setPacks} step={0.5} min={0.5} />
      ) : (
        <Stepper label="Pieces prepared" value={pieces} setValue={setPieces} step={1} min={1} />
      )}

      <button className="btn btn-primary" onClick={logBatch}>
        Log prep batch
      </button>
      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}

      <div>
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          Today&apos;s fresh entries
        </p>
        {logs.length === 0 && <p className="font-mono text-xs text-ink-soft">No entries yet.</p>}
        {logs.map((l) => (
          <div
            key={l.id}
            className="flex justify-between border-b border-dotted border-[#d8cdb0] py-1.5 font-mono text-[11px] text-ink-soft"
          >
            <span>
              {timeOf(l.timestamp)} · {l.product_name}
            </span>
            <span>
              {l.prep_unit === "PACK" ? `${l.packs_used} pack` : "manual"} → {l.pieces_prepared} pcs
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
}: {
  label: string;
  value: number;
  setValue: (n: number) => void;
  step: number;
  min: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-4">
        <button
          className="h-8 w-8 rounded-full border border-ink font-mono"
          onClick={() => setValue(Math.max(min, +(value - step).toFixed(2)))}
        >
          −
        </button>
        <span className="num min-w-[3rem] text-center text-base">{value}</span>
        <button
          className="h-8 w-8 rounded-full border border-ink font-mono"
          onClick={() => setValue(+(value + step).toFixed(2))}
        >
          +
        </button>
      </div>
    </div>
  );
}
