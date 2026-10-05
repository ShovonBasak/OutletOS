"use client";

import { bdt, shortDate } from "@/lib/format";
import { BALANCE_COLOR, transactionHeadline, transferCustomNote } from "@/lib/accountTypes";
import type { AccountTransaction } from "@/lib/types";

// Shared row for any list of AccountTransaction — the Accounts dashboard's
// "Recent activity" and the full Transaction log both render exactly this,
// so the two always look identical and only ever change in one place.
// Delete is opt-in (only the admin-gated Transaction log passes it).
interface Props {
  t: AccountTransaction;
  deleteConfirm?: boolean;
  onDeleteClick?: () => void;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
}

export default function TransactionCard({
  t, deleteConfirm, onDeleteClick, onConfirmDelete, onCancelDelete,
}: Props) {
  const amt = Number(t.amount);
  const { headline, isTransfer } = transactionHeadline(t);
  // The headline replaces a transfer's note with the "A → B" flow — if the
  // owner actually typed something when moving the money, it still needs
  // to show up somewhere, not disappear.
  const note = isTransfer ? transferCustomNote(t) : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border-2 border-[#d8cdb0] bg-[#fffdf7] px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[14px] font-bold text-ink">{headline}</p>
          {note && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{note}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-ink-soft">
            {!isTransfer && (
              <span className="rounded bg-paper-dim px-1.5 py-0.5">{t.account_name}</span>
            )}
            <span>{shortDate(t.date)}</span>
          </div>
        </div>
        <p className={`shrink-0 font-mono text-[16px] font-bold ${amt >= 0 ? "text-leaf-deep" : "text-chili-deep"}`}>
          {amt >= 0 ? "+" : ""}{bdt(amt)}
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-dotted border-[#d8cdb0] pt-2 font-mono text-[11px]">
        <span className={`rounded px-1.5 py-0.5 ${amt >= 0 ? "bg-leaf/10 text-leaf-deep" : "bg-chili/10 text-chili-deep"}`}>
          {t.transaction_type_display}
        </span>
        <span className="text-ink-soft">
          {bdt(t.balance_before)} → <span className={`font-semibold ${BALANCE_COLOR(Number(t.balance_after))}`}>{bdt(t.balance_after)}</span>
        </span>
      </div>

      {onDeleteClick && (
        <div className="flex items-center justify-end border-t border-dotted border-[#d8cdb0] pt-2">
          {deleteConfirm ? (
            <span className="flex items-center gap-3">
              <button className="font-mono text-[11px] font-bold text-chili-deep" onClick={onConfirmDelete}>
                Confirm delete
              </button>
              <button className="font-mono text-[11px] text-ink-soft" onClick={onCancelDelete}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="font-mono text-[11px] text-chili opacity-60" onClick={onDeleteClick}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
