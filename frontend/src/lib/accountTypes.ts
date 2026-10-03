import type { AccountType } from "./types";

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
