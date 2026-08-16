"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import type { DailyClosing, DayStartStockCheck, OperatingDay, Paginated, Product, RawStock } from "@/lib/types";

function nextDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  // Use local-time date constructor to avoid UTC offset shifting the date string
  const dt = new Date(y, m - 1, day + 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export default function ClosingDetail() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const params = useParams();
  const date = params.date as string;
  const [closing, setClosing] = useState<DailyClosing | null>(null);
  const [priceMap, setPriceMap] = useState<Record<number, number>>({});
  const [rawChecks, setRawChecks] = useState<DayStartStockCheck[]>([]);
  const [rawStock, setRawStock] = useState<RawStock[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Paginated<DailyClosing>>(`/daily-closings/?outlet=${outlet}&date=${date}&expand=full`),
      api<Paginated<Product>>("/products/?active=true"),
      api<Paginated<OperatingDay>>(`/operating-days/?outlet=${outlet}&date=${nextDate(date)}`),
      api<Paginated<RawStock>>(`/raw-stock/?outlet=${outlet}`),
    ]).then(([cd, pd, nextOp, rs]) => {
      setClosing(cd.results[0] ?? null);
      const map: Record<number, number> = {};
      pd.results.forEach((p) => { map[p.id] = Number(p.selling_price); });
      setPriceMap(map);
      // next day's system_carried_qty = what raw stock was at end of this closing day
      const checks = nextOp.results[0]?.stock_checks ?? [];
      setRawChecks(checks.filter((c) => c.ingredient_group !== "BEVERAGE" && Number(c.system_carried_qty) > 0));
      // fallback: use current raw stock if next day hasn't started yet
      setRawStock(rs.results.filter((r) => r.tracking_mode === "RECIPE_LINKED" && r.ingredient_group !== "BEVERAGE" && Number(r.quantity_available) > 0));
    }).finally(() => setLoaded(true));
  }, [outlet, date]);

  if (!loaded) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;
  if (!closing) return (
    <div className="flex flex-col gap-3">
      <Link href="/staff/closing/history" className="font-mono text-sm text-ink-soft">‹ Back</Link>
      <p className="font-mono text-xs text-ink-soft">No closing found for {shortDate(date)}.</p>
    </div>
  );

  // --- derived values ---
  const onlineLines = closing.sales_lines.filter((l) => l.source === "STAFF_ENTRY");
  const walkinLines = closing.sales_lines.filter((l) => l.source === "SYSTEM_DERIVED");

  // group online lines by channel
  const byChannel: Record<string, typeof onlineLines> = {};
  for (const l of onlineLines) {
    (byChannel[l.channel_name] ??= []).push(l);
  }

  const onlineTotal = onlineLines.reduce((s, l) => s + Number(l.net_amount), 0);
  const walkinTotal = walkinLines.reduce((s, l) => s + Number(l.net_amount), 0);

  const preparedRows = closing.stock_counts
    .filter((sc) => sc.requires_preparation && sc.available_pieces > 0)
    .map((sc) => ({ ...sc, price: priceMap[sc.product] ?? 0, total: sc.available_pieces * (priceMap[sc.product] ?? 0) }));
  const preparedTotal = preparedRows.reduce((s, r) => s + r.total, 0);

  const remainsRows = closing.stock_counts
    .filter((sc) => sc.requires_preparation && sc.remains_pieces > 0)
    .map((sc) => ({ ...sc, price: priceMap[sc.product] ?? 0, total: sc.remains_pieces * (priceMap[sc.product] ?? 0) }));
  const remainsTotal = remainsRows.reduce((s, r) => s + r.total, 0);

  const readyStockRows = closing.stock_counts
    .filter((sc) => !sc.requires_preparation && sc.remains_pieces > 0)
    .map((sc) => ({ ...sc, price: priceMap[sc.product] ?? 0, total: sc.remains_pieces * (priceMap[sc.product] ?? 0) }));
  const readyStockTotal = readyStockRows.reduce((s, r) => s + r.total, 0);

  const wastageRows = closing.stock_counts
    .filter((sc) => sc.wastage_pieces > 0)
    .map((sc) => ({ ...sc, price: priceMap[sc.product] ?? 0, total: sc.wastage_pieces * (priceMap[sc.product] ?? 0) }));
  const wastageTotal = wastageRows.reduce((s, r) => s + r.total, 0);

  const cashEntry = closing.payments.find((p) => p.is_primary_cash);
  const otherPayments = closing.payments.filter((p) => !p.is_primary_cash);

  return (
    <div className="flex flex-col gap-5 pb-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/staff/closing/history" className="font-mono text-sm text-ink-soft">‹</Link>
          <div>
            <h1 className="font-display text-xl font-bold">{shortDate(date)}</h1>
            <p className="text-xs text-ink-soft">{closing.staff_name}</p>
          </div>
        </div>
        <Stamp status={closing.status} />
      </div>

      {/* Revenue summary */}
      <Section title="Revenue">
        <Row label="Online sales" value={bdt(onlineTotal)} />
        <Row label="Walk-in sales" value={bdt(walkinTotal)} />
        {closing.channel_discounts.filter(d => Number(d.discount_amount) > 0).map((d) => (
          <Row key={d.id} label={`${d.channel_name} discount`} value={`− ${bdt(d.discount_amount)}`} valueClass="text-chili" />
        ))}
        <Divider />
        <Row label="Net revenue" value={bdt(closing.channel_day_net_revenue)} bold />
        <Divider />
        {cashEntry && <Row label={cashEntry.account_name} value={bdt(cashEntry.amount)} />}
        {otherPayments.map((p) => (
          <Row key={p.id} label={p.account_name} value={bdt(p.amount)} />
        ))}
      </Section>

      {/* Online sales by channel */}
      {Object.keys(byChannel).length > 0 && (
        <Section title="Online sales">
          {Object.entries(byChannel).map(([channelName, lines], ci) => {
            const subtotal = lines.reduce((s, l) => s + Number(l.net_amount), 0);
            return (
              <div key={channelName}>
                {ci > 0 && <Divider />}
                <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                  {channelName}
                </p>
                {lines.map((l) => (
                  <div key={l.id} className="ticket-row font-mono text-[11px]">
                    <span>{l.product_name} <span className="text-ink-soft">× {l.quantity_sold} @ {bdt(l.unit_price)}</span></span>
                    <span className="num">{bdt(l.net_amount)}</span>
                  </div>
                ))}
                <div className="ticket-row mt-0.5 font-mono text-[11px] font-semibold">
                  <span>{channelName} total</span>
                  <span className="num">{bdt(subtotal)}</span>
                </div>
              </div>
            );
          })}
          {Object.keys(byChannel).length > 1 && (
            <>
              <Divider />
              <Row label="Online total" value={bdt(onlineTotal)} bold />
            </>
          )}
        </Section>
      )}

      {/* Walk-in sales */}
      {walkinLines.length > 0 && (
        <Section title="Walk-in sales (derived)">
          {walkinLines.map((l) => (
            <div key={l.id} className="ticket-row font-mono text-[11px]">
              <span>{l.product_name} <span className="text-ink-soft">× {l.quantity_sold} @ {bdt(l.unit_price)}</span></span>
              <span className="num">{bdt(l.net_amount)}</span>
            </div>
          ))}
          <Divider />
          <Row label="Walk-in total" value={bdt(walkinTotal)} bold />
        </Section>
      )}

      {/* Prepared products */}
      {preparedRows.length > 0 && (
        <Section title="Prepared (available to sell)">
          <p className="mb-2 font-mono text-[10px] text-ink-soft">
            Total value of items available at closing time
          </p>
          {preparedRows.map((r) => (
            <div key={r.id} className="ticket-row font-mono text-[11px]">
              <span>{r.product_name} <span className="text-ink-soft">× {r.available_pieces} @ {bdt(r.price)}</span></span>
              <span className="num">{bdt(r.total)}</span>
            </div>
          ))}
          <Divider />
          <Row label="Prepared total" value={bdt(preparedTotal)} bold />
        </Section>
      )}

      {/* Remains */}
      {remainsRows.length > 0 && (
        <Section title="Remains (unsold, carried over)">
          {remainsRows.map((r) => (
            <div key={r.id} className="ticket-row font-mono text-[11px]">
              <span>{r.product_name} <span className="text-ink-soft">× {r.remains_pieces} @ {bdt(r.price)}</span></span>
              <span className="num">{bdt(r.total)}</span>
            </div>
          ))}
          <Divider />
          <Row label="Remains total" value={bdt(remainsTotal)} bold />
        </Section>
      )}

      {/* End-of-day stock: ready products (beverages, add-ons) */}
      {readyStockRows.length > 0 && (
        <Section title="End-of-day stock (ready products)">
          <p className="mb-2 font-mono text-[10px] text-ink-soft">
            Unsold beverages & ready items remaining at close
          </p>
          {readyStockRows.map((r) => (
            <div key={r.id} className="ticket-row font-mono text-[11px]">
              <span>{r.product_name} <span className="text-ink-soft">× {r.remains_pieces} @ {bdt(r.price)}</span></span>
              <span className="num">{bdt(r.total)}</span>
            </div>
          ))}
          <Divider />
          <Row label="Ready stock total" value={bdt(readyStockTotal)} bold />
        </Section>
      )}

      {/* End-of-day raw ingredient stock */}
      {(rawChecks.length > 0 || rawStock.length > 0) && (() => {
        const useChecks = rawChecks.length > 0;
        return (
          <Section title="End-of-day stock (raw ingredients)">
            {!useChecks && (
              <p className="mb-2 font-mono text-[10px] text-ink-soft/60 italic">
                Next day not started — showing current balance
              </p>
            )}
            {useChecks
              ? rawChecks
                  .sort((a, b) => a.ingredient_display_name.localeCompare(b.ingredient_display_name))
                  .map((c) => (
                    <div key={c.id} className="ticket-row font-mono text-[11px]">
                      <span>{c.ingredient_display_name}</span>
                      <span className="num">
                        {Number(c.system_carried_qty) % 1 === 0
                          ? Number(c.system_carried_qty)
                          : Number(c.system_carried_qty).toFixed(2)}{" "}
                        <span className="text-ink-soft">{c.base_unit}</span>
                      </span>
                    </div>
                  ))
              : rawStock
                  .sort((a, b) => a.ingredient_display_name.localeCompare(b.ingredient_display_name))
                  .map((r) => (
                    <div key={r.id} className="ticket-row font-mono text-[11px]">
                      <span>{r.ingredient_display_name}</span>
                      <span className="num">
                        {Number(r.quantity_available) % 1 === 0
                          ? Number(r.quantity_available)
                          : Number(r.quantity_available).toFixed(2)}{" "}
                        <span className="text-ink-soft">{r.base_unit}</span>
                      </span>
                    </div>
                  ))}
          </Section>
        );
      })()}

      {/* Wastage */}
      {wastageRows.length > 0 && (
        <Section title="Wastage (binned)">
          {wastageRows.map((r) => (
            <div key={r.id} className="ticket-row font-mono text-[11px]">
              <span>{r.product_name} <span className="text-ink-soft">× {r.wastage_pieces} @ {bdt(r.price)}</span></span>
              <span className="num text-chili">{bdt(r.total)}</span>
            </div>
          ))}
          <Divider />
          <Row label="Wastage total" value={bdt(wastageTotal)} bold valueClass="text-chili" />
        </Section>
      )}

    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ticket flex flex-col gap-0.5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-ink-soft">{title}</p>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-dotted border-[#d8cdb0]" />;
}

function Row({
  label,
  value,
  bold,
  valueClass,
}: {
  label: string;
  value: string;
  bold?: boolean;
  valueClass?: string;
}) {
  return (
    <div className={`ticket-row font-mono text-[11px] ${bold ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className={`num ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
