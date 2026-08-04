/**
 * Grouped account <select> — renders <optgroup> per account type.
 * Accepts any list of objects that have id, account_type, name.
 * Optionally shows balances (owner view) when current_balance is present.
 */
import { bdt } from "@/lib/format";

export interface AccountOption {
  id: number;
  account_type: string;
  name: string;
  current_balance?: string;
}

const TYPE_ORDER = ["CASH", "MOBILE_WALLET", "BANK", "SUPPLIER_CREDIT"] as const;

const TYPE_LABELS: Record<string, string> = {
  CASH: "Cash",
  MOBILE_WALLET: "Mobile Wallet",
  BANK: "Bank",
  SUPPLIER_CREDIT: "Supplier Credit",
};

interface Props {
  accounts: AccountOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  showBalance?: boolean;
  required?: boolean;
}

export default function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder = "— select account —",
  className = "field-input",
  showBalance = false,
  required = false,
}: Props) {
  // Group by account_type, preserving TYPE_ORDER
  const grouped = TYPE_ORDER.reduce<Record<string, AccountOption[]>>((acc, type) => {
    const items = accounts.filter((a) => a.account_type === type);
    if (items.length) acc[type] = items;
    return acc;
  }, {});

  // Any types not in TYPE_ORDER go at the end
  const extraTypes = [...new Set(accounts.map((a) => a.account_type))].filter(
    (t) => !TYPE_ORDER.includes(t as typeof TYPE_ORDER[number])
  );
  for (const t of extraTypes) {
    grouped[t] = accounts.filter((a) => a.account_type === t);
  }

  const allTypes = [...TYPE_ORDER.filter((t) => grouped[t]), ...extraTypes.filter((t) => grouped[t])];

  const label = (a: AccountOption) =>
    showBalance && a.current_balance != null
      ? `${a.name} (${bdt(a.current_balance)})`
      : a.name;

  return (
    <select
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={required}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {allTypes.map((type) => (
        <optgroup key={type} label={TYPE_LABELS[type] ?? type}>
          {grouped[type].map((a) => (
            <option key={a.id} value={String(a.id)}>
              {label(a)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
