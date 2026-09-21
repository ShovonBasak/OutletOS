"use client";

import type { StockInItem } from "@/lib/types";

function fmt(val: string | null | undefined, decimals = 2): string {
  if (val == null || val === "") return "—";
  const n = parseFloat(val);
  return isNaN(n) ? "—" : n.toFixed(decimals);
}

function fmtQty(val: string | null | undefined): string {
  if (val == null || val === "") return "—";
  const n = parseFloat(val);
  return isNaN(n) ? "—" : String(Number(n));
}

export function StockInItemTable({
  items,
  expectedTotal,
}: {
  items: StockInItem[];
  /** Slip's own printed grand total (after tax), if known — compared against the
   * summed line totals below so a mismatch (e.g. a missed/misread line) surfaces
   * before approval instead of only being caught by manually re-adding the slip. */
  expectedTotal?: string | number | null;
}) {
  const hasTax = items.some((i) => i.vat_rate || i.sd_rate);

  const itemsTotal = items.reduce((s, i) => {
    const v = parseFloat(i.line_total ?? "");
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  const expected = expectedTotal != null && expectedTotal !== "" ? parseFloat(String(expectedTotal)) : null;
  const diff = expected != null && !isNaN(expected) ? itemsTotal - expected : null;
  const mismatched = diff != null && Math.abs(diff) >= 1;

  return (
    <div className="mt-2 overflow-x-auto border-t border-[#d8cdb0]">
      <table className="w-full min-w-[520px] border-collapse font-mono text-[11px]">
        <thead>
          <tr className="border-b border-[#d8cdb0] text-[10px] uppercase tracking-wide text-ink-soft">
            <th className="py-1.5 pr-3 text-left">Ingredient</th>
            <th className="py-1.5 pr-3 text-right">Qty</th>
            <th className="py-1.5 pr-3 text-right">Rate</th>
            {hasTax && (
              <>
                <th className="py-1.5 pr-3 text-right">SD%</th>
                <th className="py-1.5 pr-3 text-right">SD ৳</th>
                <th className="py-1.5 pr-3 text-right">VAT%</th>
                <th className="py-1.5 pr-3 text-right">VAT ৳</th>
              </>
            )}
            <th className="py-1.5 pr-3 text-right">Total</th>
            <th className="py-1.5 text-right">Unit (after tax)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr
              key={item.id ?? i}
              className="border-b border-dotted border-[#e8e0cc] last:border-0"
            >
              <td className="py-1.5 pr-3 font-medium text-ink">
                {item.ingredient_name ?? item.raw_extracted_text ?? "—"}
                {item.is_unrecognized && (
                  <span className="ml-1 text-chili">(unrecognized)</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right">
                {fmtQty(item.confirmed_quantity)}
                {item.base_unit && (
                  <span className="ml-0.5 text-ink-soft">{item.base_unit}</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right">
                {item.rate ? `৳${fmt(item.rate)}` : "—"}
              </td>
              {hasTax && (
                <>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.sd_rate ? `${fmt(item.sd_rate)}%` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.sd_amount ? `৳${fmt(item.sd_amount)}` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.vat_rate ? `${fmt(item.vat_rate)}%` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.vat_amount ? `৳${fmt(item.vat_amount)}` : "—"}
                  </td>
                </>
              )}
              <td className="py-1.5 pr-3 text-right font-semibold">
                {item.line_total ? `৳${fmt(item.line_total)}` : "—"}
              </td>
              <td className="py-1.5 text-right text-ink-soft">
                {item.unit_price ? `৳${fmt(item.unit_price, 4)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {mismatched && (
        <p className="mt-2 rounded border border-chili bg-[#fdece1] px-2 py-1.5 font-mono text-[11px] font-semibold text-chili-deep">
          ⚠ Line totals add up to ৳{itemsTotal.toFixed(2)}, but the slip total is ৳{expected!.toFixed(2)}
          {" "}(off by ৳{Math.abs(diff!).toFixed(2)}) — check for a missing, duplicated, or misread line.
        </p>
      )}
    </div>
  );
}
