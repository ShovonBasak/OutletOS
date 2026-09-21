"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { today } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import AccountPicker from "@/components/AccountPicker";
import { StockInItemTable } from "@/components/StockInItemTable";
import type { FinancialAccount, StockInRecord } from "@/lib/types";

export function fullDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function sourceLabel(r: StockInRecord, detail: StockInRecord | null): string {
  const items = detail?.items ?? r.items;
  if (r.source_summary && !items) return r.source_summary;
  if (items) {
    const hasSlip = items.some((i) => i.source === "SLIP_EXTRACTED");
    const hasManual = items.some((i) => i.source === "MANUAL");
    if (hasSlip && hasManual) return "Slip + manual";
    if (hasSlip) return "Slip";
    return "Manual";
  }
  return r.source_summary ?? "Manual";
}

// Collapsible invoice card — shows summary, expands to full item detail plus
// (for PENDING) inline date correction, paid-from-account, and approve/reject,
// or (for DRAFT) resume/delete. Shared between the "all stock-in" list and the
// Approvals queue so both surfaces offer identical editing, not just viewing.
export function StockInInvoiceRow({
  r,
  busy,
  accounts,
  onAct,
  onResume,
  onEditDate,
  alwaysShowActions = false,
}: {
  r: StockInRecord;
  busy: boolean;
  accounts: FinancialAccount[];
  onAct: (id: number, action: "approve" | "reject" | "delete", accountId?: number | null) => void;
  onResume?: (detail: StockInRecord) => void;
  onEditDate?: (id: number, newDate: string) => void;
  /** Show Approve/Reject even while collapsed (Approvals queue's quick-action use case). */
  alwaysShowActions?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StockInRecord | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const primaryId = accounts.find((a) => a.is_primary_cash)?.id ?? accounts[0]?.id;
  const [approvalAccount, setApprovalAccount] = useState(
    r.paid_from_account ? String(r.paid_from_account) : (primaryId ? String(primaryId) : "")
  );
  const [dateEdit, setDateEdit] = useState(r.stock_in_date);
  useEffect(() => { setDateEdit(r.stock_in_date); }, [r.stock_in_date]);
  const invoiceLabel = r.invoice_number
    ? r.invoice_number
    : `#SI-${String(r.id).padStart(4, "0")}`;

  const grandTotal = r.slip_grand_total ?? null;
  const totalLabel = grandTotal && parseFloat(grandTotal) > 0 ? `৳${parseFloat(grandTotal).toFixed(2)}` : null;

  async function handleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setLoadingDetail(true);
      try {
        const full = await api<StockInRecord>(`/stock-in/${r.id}/`);
        setDetail(full);
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  const items = detail?.items;

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper">
      <button
        className="w-full px-4 pt-3 pb-2.5 text-left"
        onClick={handleOpen}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-0.5">Invoice</p>
            <p className="font-display text-sm font-bold text-ink truncate">{invoiceLabel}</p>
          </div>
          <Stamp status={r.status} flat />
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Date</p>
            {r.status === "PENDING" && r.stock_in_date !== today() ? (
              <p
                className="mt-0.5 inline-flex items-center gap-1 rounded border border-chili bg-[#fdece1] px-1.5 py-0.5 font-mono text-[11px] font-bold text-chili-deep"
                title="Doesn't match today's date"
              >
                ⚠ {fullDate(r.stock_in_date)}
              </p>
            ) : (
              <p className="font-mono text-[11px] text-ink">{fullDate(r.stock_in_date)}</p>
            )}
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Source</p>
            <p className="font-mono text-[11px] text-ink">{sourceLabel(r, detail)}</p>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Submitted by</p>
            <p className="font-mono text-[11px] text-ink">{r.submitted_by_name}</p>
          </div>
          {totalLabel && (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Total (after tax)</p>
              <p className="font-mono text-[12px] font-semibold text-ink">{totalLabel}</p>
            </div>
          )}
          <span className="ml-auto font-mono text-[10px] text-ink-soft">
            {open ? "▴ less" : "▾ details"}
          </span>
        </div>
      </button>

      {alwaysShowActions && r.status === "PENDING" && (
        <div className="qbtns px-3 pb-3">
          <button
            className="approve"
            disabled={busy}
            onClick={() => onAct(r.id, "approve", approvalAccount ? Number(approvalAccount) : null)}
          >
            Approve
          </button>
          <button className="reject" disabled={busy} onClick={() => onAct(r.id, "reject")}>
            Reject
          </button>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3">
          {loadingDetail ? (
            <p className="py-2 font-mono text-[11px] text-ink-soft">Loading…</p>
          ) : !items || items.length === 0 ? (
            <p className="py-2 font-mono text-[11px] text-ink-soft">No items on this record.</p>
          ) : (
            <StockInItemTable items={items} expectedTotal={grandTotal} />
          )}

          {r.slip_image && (
            <div className="mt-3">
              <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-soft">Delivery slip</p>
              <a href={r.slip_image} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.slip_image}
                  alt="Delivery slip"
                  className="max-h-64 w-full rounded border border-[#d8cdb0] object-contain bg-[#faf7ee] cursor-zoom-in"
                />
                <p className="mt-1 font-mono text-[10px] text-leaf-deep underline">Open full size ↗</p>
              </a>
            </div>
          )}

          {r.status === "PENDING" && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-ink-soft">
                  Invoice date {dateEdit !== r.stock_in_date && <span className="text-chili-deep">(unsaved)</span>}
                </span>
                <p className="font-mono text-[9px] text-ink-soft/70">
                  Slip OCR sometimes misreads this — correct it before approving.
                </p>
                {dateEdit !== today() && (
                  <p className="font-mono text-[9px] text-chili-deep">
                    ⚠ This date isn&apos;t today ({fullDate(today())}). Fine for a backdated/late slip —
                    otherwise double-check it.
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    type="date"
                    className="field-input flex-1"
                    value={dateEdit}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDateEdit(e.target.value)}
                  />
                  {dateEdit !== today() && (
                    <button
                      className="btn btn-ghost !px-3 !py-1.5 font-mono text-[11px] shrink-0 !border-chili !text-chili-deep"
                      onClick={(e) => { e.stopPropagation(); setDateEdit(today()); }}
                    >
                      Select today
                    </button>
                  )}
                  <button
                    className="btn btn-ghost !px-3 !py-1.5 font-mono text-[11px] shrink-0"
                    disabled={busy || dateEdit === r.stock_in_date || !dateEdit}
                    onClick={(e) => { e.stopPropagation(); onEditDate?.(r.id, dateEdit); }}
                  >
                    Save date
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-ink-soft">Paid from account</span>
                <AccountPicker
                  accounts={accounts.filter((a) => a.is_active)}
                  value={approvalAccount}
                  onChange={setApprovalAccount}
                  showBalance
                  placeholder="— not specified —"
                />
              </div>
              {!alwaysShowActions && (
                <div className="flex gap-2">
                  <button
                    className="rounded-sm bg-leaf px-3 py-1 font-mono text-[11px] uppercase text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAct(r.id, "approve", approvalAccount ? Number(approvalAccount) : null);
                    }}
                  >
                    Approve
                  </button>
                  <button
                    className="rounded-sm border border-chili px-3 py-1 font-mono text-[11px] uppercase text-chili-deep disabled:opacity-50"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); onAct(r.id, "reject"); }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          )}
          {r.status === "DRAFT" && (
            <div className="mt-3 flex items-center gap-4">
              {onResume && (
                <button
                  className="font-mono text-[11px] text-leaf-deep underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (detail) {
                      onResume(detail);
                    } else {
                      api<StockInRecord>(`/stock-in/${r.id}/`).then(onResume);
                    }
                  }}
                >
                  Edit &amp; submit →
                </button>
              )}
              <button
                className="font-mono text-[10px] text-chili underline disabled:opacity-50"
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); onAct(r.id, "delete"); }}
              >
                Delete draft
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
