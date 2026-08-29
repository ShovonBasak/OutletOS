"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestionRow {
  ingredient_name: string;
  base_unit: string;
  stock_on_hand: number;
  pre_delivery_estimated_use: number;
  effective_stock_at_delivery: number;
  projected_usage: number;
  required_with_buffer: number;
  to_order_raw: number;
  packs_to_order: number | null;
  pieces_per_pack: number | null;
  pieces_to_order: number;
  cost_per_pack: number | null;
  estimated_cost: number | null;
  needs_order: boolean;
}

interface OrderResult {
  delivery_date: string;
  next_delivery_date: string;
  pre_delivery_days: number;
  pre_delivery_label: string;
  days_to_cover: number;
  coverage_label: string;
  suggestions: SuggestionRow[];
  total_estimated_cost: number;
  whatsapp_text: string;
  data_quality: {
    history_days: number;
    operating_days_analyzed: number;
    confidence: "High" | "Medium" | "Low";
  };
}

// ── Delivery date helpers ─────────────────────────────────────────────────────

// JS getDay(): Sun=0, Tue=2, Thu=4
const DELIVERY_DAYS = new Set([0, 2, 4]);

function nextDeliveryDates(n = 5): Date[] {
  const results: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (results.length < n) {
    if (DELIVERY_DAYS.has(d.getDay())) results.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return results;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
}

function fmtShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ConfidenceBadge({ c }: { c: "High" | "Medium" | "Low" }) {
  const cfg = {
    High:   "bg-leaf/10 text-leaf-deep border-leaf/20",
    Medium: "bg-gold/15 text-gold-deep border-gold/20",
    Low:    "bg-chili/10 text-chili border-chili/20",
  }[c];
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest ${cfg}`}>
      {c} confidence
    </span>
  );
}

function bdt(n: number): string {
  return `৳${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalystPage() {
  const deliveryOptions = nextDeliveryDates(5);
  const [selectedIso, setSelectedIso] = useState(toIso(deliveryOptions[0]));
  const [result, setResult] = useState<OrderResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchSuggestion(selectedIso);
  }, [selectedIso]);

  async function fetchSuggestion(iso: string) {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const data = await api<OrderResult>(
        `/analyst/order-suggestion/?delivery_date=${iso}`
      );
      setResult(data);
    } catch {
      setError("Could not load order suggestion.");
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.whatsapp_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = result.whatsapp_text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-8">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div>
        <h1 className="font-mono text-[13px] font-semibold text-ink">Order Planner</h1>
        <p className="font-mono text-[10px] text-ink-soft/60">
          AI-powered ingredient order suggestions based on sales history
        </p>
      </div>

      {/* ── Delivery date picker ────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">
          Select delivery date
        </p>
        <div className="flex flex-wrap gap-2">
          {deliveryOptions.map((d) => {
            const iso = toIso(d);
            const active = iso === selectedIso;
            const dayName = d.toLocaleDateString("en-GB", { weekday: "short" });
            const dayDate = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
            return (
              <button
                key={iso}
                onClick={() => setSelectedIso(iso)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-chrome/60 bg-chrome/10 text-chrome"
                    : "border-[#d8cdb0] bg-paper text-ink-soft hover:bg-paper-dim"
                }`}
              >
                <p className="font-mono text-[11px] font-semibold">{dayName}</p>
                <p className="font-mono text-[10px]">{dayDate}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Loading / error ─────────────────────────────────────────────── */}
      {loading && (
        <p className="font-mono text-[11px] text-ink-soft animate-pulse">
          Analysing {result ? result.data_quality.history_days : 56} days of sales data…
        </p>
      )}
      {error && (
        <p className="font-mono text-[11px] text-chili">{error}</p>
      )}

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {result && !loading && (
        <div className="flex flex-col gap-3">

          {/* Coverage summary card */}
          <div className="rounded-xl border border-[#d8cdb0] bg-paper px-4 py-3 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="font-mono text-[12px] font-semibold text-ink">
                  {fmtDate(result.delivery_date)}
                </p>
                <p className="font-mono text-[10px] text-ink-soft">
                  Order covers {result.coverage_label}
                </p>
              </div>
              <ConfidenceBadge c={result.data_quality.confidence} />
            </div>

            {result.pre_delivery_days > 0 && (
              <div className="rounded-lg border border-gold/30 bg-gold/8 px-3 py-2">
                <p className="font-mono text-[10px] text-gold-deep">
                  {result.pre_delivery_label} — estimated stock use before delivery
                </p>
                <p className="font-mono text-[9px] text-ink-soft/60 mt-0.5">
                  Current stock reduced by projected sales during this window
                </p>
              </div>
            )}

            <div className="flex gap-4 flex-wrap">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">Items to order</p>
                <p className="font-mono text-[15px] font-semibold text-ink">
                  {result.suggestions.filter((s) => s.needs_order).length}
                  <span className="font-mono text-[10px] text-ink-soft/50 font-normal">
                    /{result.suggestions.length}
                  </span>
                </p>
              </div>
              {result.total_estimated_cost > 0 && (
                <div>
                  <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">Est. cost</p>
                  <p className="font-mono text-[15px] font-semibold text-ink">{bdt(result.total_estimated_cost)}</p>
                </div>
              )}
              <div>
                <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">Data used</p>
                <p className="font-mono text-[11px] text-ink-soft">
                  {result.data_quality.operating_days_analyzed} of {result.data_quality.history_days} days
                </p>
              </div>
            </div>

            {result.data_quality.confidence === "Low" && (
              <p className="font-mono text-[10px] text-chili">
                ⚠ Low confidence — less than 3 weeks of sales history available. Suggestion may be inaccurate.
              </p>
            )}
          </div>

          {/* Copy button */}
          {result.suggestions.length > 0 && (
            <button
              onClick={copyToClipboard}
              className={`self-start flex items-center gap-2 rounded-xl border px-4 py-2 font-mono text-[11px] transition-colors ${
                copied
                  ? "border-leaf/40 bg-leaf/10 text-leaf-deep"
                  : "border-chrome/40 bg-chrome/5 text-chrome hover:bg-chrome/10"
              }`}
            >
              {copied ? "✓ Copied!" : "📋 Copy for WhatsApp"}
            </button>
          )}

          {/* Suggestion table — always shown; zero-order rows appear dimmed */}
          <div className="flex flex-col gap-0 rounded-xl border border-[#d8cdb0] overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 bg-paper-dim px-3 py-2 border-b border-[#d8cdb0]">
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">Ingredient</p>
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50 text-right">Effective stock</p>
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50 text-right">To order</p>
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50 text-right">Est. cost</p>
            </div>

            {/* Rows */}
            {result.suggestions.map((s, i) => (
              <div
                key={s.ingredient_name}
                className={`grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-center px-3 py-2.5 ${
                  i < result.suggestions.length - 1 ? "border-b border-[#e8dfc8]" : ""
                } ${s.needs_order ? "" : "opacity-50"}`}
              >
                {/* Name */}
                <div className="min-w-0">
                  <p className={`font-mono text-[11px] font-medium truncate ${s.needs_order ? "text-ink" : "text-ink-soft"}`}>
                    {s.ingredient_name}
                  </p>
                  <p className="font-mono text-[9px] text-ink-soft/60">
                    {s.needs_order
                      ? `needs ${s.required_with_buffer.toFixed(1)} ${s.base_unit} (incl. 15% buffer)`
                      : `sufficient — needs ${s.required_with_buffer.toFixed(1)} ${s.base_unit}`}
                  </p>
                </div>

                {/* Effective stock at delivery */}
                <div className="text-right">
                  {s.pieces_per_pack ? (
                    <>
                      <p className="font-mono text-[11px] text-ink-soft whitespace-nowrap">
                        {Math.floor(s.effective_stock_at_delivery / s.pieces_per_pack)} pk
                      </p>
                      <p className="font-mono text-[9px] text-ink-soft/60 whitespace-nowrap">
                        {s.effective_stock_at_delivery.toFixed(1)} {s.base_unit}
                      </p>
                    </>
                  ) : (
                    <p className="font-mono text-[11px] text-ink-soft whitespace-nowrap">
                      {s.effective_stock_at_delivery.toFixed(1)} {s.base_unit}
                    </p>
                  )}
                </div>

                {/* To order */}
                <div className="text-right">
                  {s.needs_order ? (
                    s.packs_to_order !== null ? (
                      <>
                        <p className="font-mono text-[12px] font-semibold text-ink whitespace-nowrap">
                          {s.packs_to_order} pk
                        </p>
                        {s.pieces_per_pack && (
                          <p className="font-mono text-[9px] text-ink-soft/60 whitespace-nowrap">
                            {Math.round((s.packs_to_order ?? 0) * s.pieces_per_pack)} {s.base_unit}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="font-mono text-[12px] font-semibold text-ink whitespace-nowrap">
                        {s.to_order_raw.toFixed(1)} {s.base_unit}
                      </p>
                    )
                  ) : (
                    <p className="font-mono text-[12px] font-semibold text-leaf-deep whitespace-nowrap">0</p>
                  )}
                </div>

                {/* Cost */}
                <p className="font-mono text-[11px] text-ink-soft whitespace-nowrap text-right">
                  {s.estimated_cost !== null ? bdt(s.estimated_cost) : "—"}
                </p>
              </div>
            ))}

            {/* Total row */}
            {result.total_estimated_cost > 0 && (
              <div className="flex items-center justify-between gap-3 border-t border-[#d8cdb0] bg-paper-dim px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft/60">
                  Total estimate
                </p>
                <p className="font-mono text-[13px] font-semibold text-ink">
                  {bdt(result.total_estimated_cost)}
                </p>
              </div>
            )}
          </div>

          {/* WhatsApp preview */}
          <details className="group">
            <summary className="cursor-pointer font-mono text-[10px] text-ink-soft/60 hover:text-ink-soft list-none flex items-center gap-1">
              <span className="group-open:hidden">▸</span>
              <span className="hidden group-open:inline">▾</span>
              WhatsApp message preview
            </summary>
            <div className="mt-2 rounded-xl border border-[#d8cdb0] bg-paper px-4 py-3">
              <pre className="font-mono text-[11px] text-ink whitespace-pre-wrap leading-relaxed">
                {result.whatsapp_text}
              </pre>
            </div>
          </details>

        </div>
      )}
    </div>
  );
}
