"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { bdt } from "@/lib/format";

export interface AccountPickerOption {
  id: number;
  account_type: string;
  name: string;
  current_balance?: string;
  is_active?: boolean;
}

const TYPE_ORDER = ["CASH", "MOBILE_WALLET", "BANK", "SUPPLIER_CREDIT"] as const;
const TYPE_LABELS: Record<string, string> = {
  CASH: "Cash",
  MOBILE_WALLET: "Mobile Wallet",
  BANK: "Bank",
  SUPPLIER_CREDIT: "Supplier Credit",
};

// ── Trigger button ───────────────────────────────────────────────────────────

interface AccountPickerProps {
  accounts: AccountPickerOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  showBalance?: boolean;
  className?: string;
}

export default function AccountPicker({
  accounts,
  value,
  onChange,
  placeholder = "— not specified —",
  showBalance = false,
  className = "",
}: AccountPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = accounts.find((a) => String(a.id) === value);
  const label = selected
    ? showBalance && selected.current_balance != null
      ? `${selected.name} · ${bdt(selected.current_balance)}`
      : selected.name
    : placeholder;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`field-input flex items-center justify-between text-left ${className}`}
        onClick={() => setOpen(true)}
      >
        <span className={selected ? "text-ink" : "text-ink-soft"}>{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-soft">▾</span>
      </button>
      <AccountPickerSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        accounts={accounts}
        selectedId={value}
        onSelect={(id) => { onChange(id); setOpen(false); }}
        showBalance={showBalance}
        triggerRef={triggerRef}
      />
    </>
  );
}

// ── Floating picker sheet ────────────────────────────────────────────────────

type PickerPos = { top: number; left: number; width: number; maxH: number };

function AccountPickerSheet({
  isOpen,
  onClose,
  accounts,
  selectedId,
  onSelect,
  showBalance,
  triggerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  accounts: AccountPickerOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  showBalance: boolean;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<PickerPos | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const GAP = 4;
        const MARGIN = 16;
        const maxViewH = window.innerHeight * 0.65;
        const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
        const spaceAbove = rect.top - MARGIN;
        if (spaceBelow >= 140 || spaceBelow >= spaceAbove) {
          setPos({ top: rect.bottom + GAP, left: rect.left, width: rect.width, maxH: Math.min(spaceBelow, maxViewH) });
        } else {
          const maxH = Math.min(spaceAbove, maxViewH);
          setPos({ top: rect.top - maxH - GAP, left: rect.left, width: rect.width, maxH });
        }
      }
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen, triggerRef]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? accounts.filter((a) => a.name.toLowerCase().includes(q)) : accounts;
  }, [accounts, search]);

  const groups = useMemo(() => {
    const map = new Map<string, AccountPickerOption[]>();
    filtered.forEach((a) => {
      const type = a.account_type;
      if (!map.has(type)) map.set(type, []);
      map.get(type)!.push(a);
    });
    const typeOrder = (t: string) => {
      const i = TYPE_ORDER.indexOf(t as typeof TYPE_ORDER[number]);
      return i === -1 ? 999 : i;
    };
    return [...map.entries()].sort(([a], [b]) => typeOrder(a) - typeOrder(b));
  }, [filtered]);

  const showGroups = groups.length > 1;

  if (!isOpen || !pos) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/20" />
      <div
        className="absolute flex flex-col overflow-hidden rounded-xl border border-[#d8cdb0] bg-paper shadow-xl"
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* search */}
        <div className="border-b border-[#d8cdb0] px-3 py-2">
          <input
            ref={inputRef}
            className="field-input w-full"
            placeholder="Search accounts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* list */}
        <div className="overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No matches.</p>
          )}
          {groups.map(([type, items]) => (
            <div key={type}>
              {showGroups && (
                <p className="sticky top-0 bg-paper px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
                  {TYPE_LABELS[type] ?? type}
                </p>
              )}
              {items.map((a) => {
                const isSelected = String(a.id) === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`flex w-full items-center justify-between border-b border-dotted border-[#d8cdb0] px-4 py-3 text-left transition-colors active:bg-paper-dim ${
                      isSelected ? "bg-action/10" : ""
                    }`}
                    onClick={() => onSelect(String(a.id))}
                  >
                    <span className={`font-mono text-sm ${isSelected ? "font-semibold text-ink" : "text-ink"}`}>
                      {a.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {showBalance && a.current_balance != null && (
                        <span className="font-mono text-[11px] text-ink-soft">
                          {bdt(a.current_balance)}
                        </span>
                      )}
                      {isSelected && (
                        <span className="font-mono text-[11px] text-chrome">✓</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
