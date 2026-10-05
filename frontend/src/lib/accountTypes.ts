import type { AccountTransaction, AccountType } from "./types";

// Shared per-account-type icon/label/color maps — previously duplicated
// inline in owner/accounts/page.tsx; promoted here since the accounts
// dashboard, MoveMoneySheet, and the manage/transactions pages all need
// the same mapping.

export const ACCOUNT_TYPE_ORDER: AccountType[] = ["CASH", "MOBILE_WALLET", "BANK", "SUPPLIER_CREDIT"];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  CASH: "Cash",
  MOBILE_WALLET: "Mobile Wallet",
  BANK: "Bank",
  SUPPLIER_CREDIT: "Supplier Credit",
};

export const ACCOUNT_TYPE_ICON: Record<AccountType, string> = {
  CASH: "💵",
  MOBILE_WALLET: "📱",
  BANK: "🏦",
  SUPPLIER_CREDIT: "🏭",
};

export const ACCOUNT_TYPE_COLOR: Record<AccountType, string> = {
  CASH: "border-chrome/40 bg-chrome/5",
  MOBILE_WALLET: "border-gold/40 bg-gold/5",
  BANK: "border-leaf/40 bg-leaf/5",
  SUPPLIER_CREDIT: "border-chili/30 bg-chili/5",
};

export const BALANCE_COLOR = (n: number): string =>
  n < 0 ? "text-chili-deep" : n > 0 ? "text-leaf-deep" : "text-ink";

/** A transfer leg alone ("Transfer to X") leaves the other side to be
 * inferred from the note text — this names both accounts, in the direction
 * the money actually moved, for the one `account`-centric row this leg is. */
export function transactionHeadline(t: AccountTransaction): { headline: string; isTransfer: boolean } {
  const isTransfer = t.transaction_type === "TRANSFER_OUT" || t.transaction_type === "TRANSFER_IN";
  if (isTransfer && t.counterpart_account_name) {
    const headline = t.transaction_type === "TRANSFER_OUT"
      ? `${t.account_name} → ${t.counterpart_account_name}`
      : `${t.counterpart_account_name} → ${t.account_name}`;
    return { headline, isTransfer: true };
  }
  return { headline: t.note || t.transaction_type_display, isTransfer };
}

/** For a transfer, `transactionHeadline` replaces the note with the "A → B"
 * flow — but if the owner typed a real note when moving the money, it was
 * then nowhere to be seen. Returns that custom note, or null when there
 * isn't one (empty, or just the backend's own auto-generated default —
 * "Transfer to X"/"Transfer from Y" — which the headline already covers). */
export function transferCustomNote(t: AccountTransaction): string | null {
  if (!t.note || !t.counterpart_account_name) return t.note || null;
  const auto = t.transaction_type === "TRANSFER_OUT"
    ? `Transfer to ${t.counterpart_account_name}`
    : `Transfer from ${t.counterpart_account_name}`;
  return t.note === auto ? null : t.note;
}
