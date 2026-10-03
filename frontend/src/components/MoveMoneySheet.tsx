"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bdt, today } from "@/lib/format";
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER } from "@/lib/accountTypes";
import { BottomSheet } from "./BottomSheet";
import type { FinancialAccount } from "@/lib/types";

// "Owner capital" (injection/withdrawal) is just money crossing the
// business boundary — the owner's own pocket on one side. Modeling it as a
// third pseudo-account rather than a separate category means the owner
// never has to pick "transfer vs capital" up front; they just say where
// money is coming from and where it's going, same as any other move. See
// the accounts-redesign mockup discussed in chat for the reasoning.
const PERSONAL_ID = "personal" as const;
interface PersonalSide {
  id: typeof PERSONAL_ID;
  name: string;
  sub: string;
}
const PERSONAL: PersonalSide = { id: PERSONAL_ID, name: "My own money", sub: "outside the shop" };

type Side = FinancialAccount | PersonalSide;
type View = "form" | "pick-from" | "pick-to";
type Kind = "transfer" | "injection" | "withdrawal";

function isPersonal(side: Side): side is PersonalSide {
  return side.id === PERSONAL_ID;
}

export function MoveMoneySheet({
  open,
  onClose,
  accounts,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  accounts: FinancialAccount[];
  onDone: (message: string) => void;
}) {
  const active = useMemo(() => accounts.filter((a) => a.is_active), [accounts]);
  const primaryCash = active.find((a) => a.is_primary_cash) ?? active[0] ?? null;

  const [view, setView] = useState<View>("form");
  const [from, setFrom] = useState<Side | null>(null);
  const [to, setTo] = useState<Side | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [dateExpanded, setDateExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [quickExpanded, setQuickExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a sane default every time the sheet is opened.
  useEffect(() => {
    if (!open) return;
    const second = active.find((a) => a.id !== primaryCash?.id) ?? null;
    setFrom(primaryCash);
    setTo(second);
    setAmount("");
    setDate(today());
    setDateExpanded(false);
    setNote("");
    setQuickExpanded(false);
    setSearch("");
    setError(null);
    setView("form");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const kind: Kind =
    from && isPersonal(from) ? "injection" : to && isPersonal(to) ? "withdrawal" : "transfer";

  const amountNum = parseFloat(amount) || 0;
  const canSubmit = !!from && !!to && from.id !== to.id && amountNum > 0;

  function fallbackAccount(excludeId: Side["id"] | undefined): Side | null {
    return active.find((a) => a.id !== excludeId) ?? null;
  }

  // Clicking an already-active chip unselects it (reverts to a real
  // account) instead of being a one-way switch.
  function quickPersonal(direction: "in" | "out") {
    if (direction === "in") {
      if (from && isPersonal(from)) {
        setFrom(fallbackAccount(to?.id));
      } else {
        setFrom(PERSONAL);
        if (to && isPersonal(to)) setTo(fallbackAccount(PERSONAL_ID));
      }
    } else {
      if (to && isPersonal(to)) {
        setTo(fallbackAccount(from?.id));
      } else {
        setTo(PERSONAL);
        if (from && isPersonal(from)) setFrom(fallbackAccount(PERSONAL_ID));
      }
    }
  }

  function swap() {
    setFrom(to);
    setTo(from);
  }

  function openPicker(side: "from" | "to") {
    setSearch("");
    setView(side === "from" ? "pick-from" : "pick-to");
  }

  function pick(side: "from" | "to", acct: Side) {
    if (side === "from") setFrom(acct); else setTo(acct);
    if (isPersonal(acct)) setQuickExpanded(true);
    setView("form");
  }

  function pickerGroups(side: "from" | "to") {
    const other = side === "from" ? to : from;
    const groups: { label: string; items: Side[] }[] = [];
    for (const type of ACCOUNT_TYPE_ORDER) {
      const items = active.filter((a) => a.account_type === type && a.id !== other?.id);
      if (items.length) groups.push({ label: ACCOUNT_TYPE_LABELS[type], items });
    }
    // Only one side can ever be "my own money" at a time — there's no
    // transaction type for personal-to-personal.
    if (!other || !isPersonal(other)) {
      groups.push({ label: "Personal", items: [PERSONAL] });
    }
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups
      .map((g) => ({ ...g, items: g.items.filter((a) => a.name.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  }

  function previewText(): string {
    if (!from || !to || from.id === to.id || amountNum <= 0) {
      return "Pick an amount and two different accounts to continue.";
    }
    const fromName = isPersonal(from) ? "your own pocket" : from.name;
    const toName = isPersonal(to) ? "your own pocket" : to.name;
    const verb = kind === "injection" ? "adding" : kind === "withdrawal" ? "withdrawing" : "transferring";
    return `You're ${verb} ${bdt(amountNum)} from ${fromName} to ${toName}.`;
  }

  function submitLabel(): string {
    if (!canSubmit) return "Move money";
    const verb = kind === "injection" ? "Add" : kind === "withdrawal" ? "Withdraw" : "Transfer";
    return `${verb} ${bdt(amountNum)}`;
  }

  async function submit() {
    if (!canSubmit || !from || !to) return;
    setSaving(true);
    setError(null);
    try {
      if (kind === "transfer") {
        await api("/account-transfers/", {
          method: "POST",
          body: JSON.stringify({
            from_account: from.id, to_account: to.id, amount, date, note,
          }),
        });
      } else {
        const businessSide = kind === "injection" ? to : from;
        await api("/capital-transactions/", {
          method: "POST",
          body: JSON.stringify({
            account: businessSide!.id,
            direction: kind === "injection" ? "INJECTION" : "WITHDRAWAL",
            amount, date, note,
          }),
        });
      }
      onDone(
        kind === "transfer"
          ? `Transfer of ${bdt(amountNum)} recorded ✓`
          : kind === "injection"
            ? `Capital injection of ${bdt(amountNum)} recorded ✓`
            : `Capital withdrawal of ${bdt(amountNum)} recorded ✓`
      );
      onClose();
    } catch {
      setError("Could not record this — please try again.");
    } finally {
      setSaving(false);
    }
  }

  const chipCls = (isActive: boolean) =>
    `flex-1 rounded-full border px-2.5 py-2 text-center font-mono text-[10.5px] uppercase tracking-wide transition-colors ${
      isActive
        ? "border-chrome bg-chrome text-paper"
        : "border-[#d8cdb0] bg-[#fffdf7] text-ink hover:border-chrome-soft"
    }`;

  return (
    <BottomSheet open={open} onClose={onClose}>
      {view === "form" && (
        <div className="flex flex-col gap-5 px-5 pb-6">
          <p className="font-display text-[16px] font-bold text-ink">Move money</p>

          <div className="flex flex-col gap-1">
            <div className="flex flex-col gap-1.5">
              <span className="field-label">From</span>
              <button type="button" onClick={() => openPicker("from")} className="field-input flex items-center justify-between text-left">
                <span className={from ? "text-ink" : "text-ink-soft"}>{from ? from.name : "Select account"}</span>
                <span className="font-mono text-[11px] text-ink-soft">▾</span>
              </button>
              {from && (
                <span className={`font-mono text-[10.5px] ${
                  !isPersonal(from) && Number(from.current_balance) < 0 ? "text-chili-deep" : "text-ink-soft"
                }`}>
                  {isPersonal(from) ? from.sub : `${bdt(from.current_balance)} available`}
                </span>
              )}
            </div>

            <div className="-my-1 flex justify-center">
              <button
                type="button"
                onClick={swap}
                title="Swap from and to"
                className="z-10 flex h-7 w-7 items-center justify-center rounded-full border border-[#d8cdb0] bg-paper font-mono text-xs text-chrome shadow-sm"
              >
                ⇅
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="field-label">To</span>
              <button type="button" onClick={() => openPicker("to")} className="field-input flex items-center justify-between text-left">
                <span className={to ? "text-ink" : "text-ink-soft"}>{to ? to.name : "Select account"}</span>
                <span className="font-mono text-[11px] text-ink-soft">▾</span>
              </button>
              {to && (
                <span className={`font-mono text-[10.5px] ${
                  !isPersonal(to) && Number(to.current_balance) < 0 ? "text-chili-deep" : "text-ink-soft"
                }`}>
                  {isPersonal(to) ? to.sub : `${bdt(to.current_balance)} available`}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {/* Short, chip-styled, and in the same wording as the picker's
                "My own money" entry — the old full-sentence question in
                small muted text didn't read as tappable and took effort to
                parse. The two revealed buttons explain themselves once open. */}
            <button
              type="button"
              onClick={() => setQuickExpanded((v) => !v)}
              className="flex items-center gap-1.5 self-start rounded-full border border-chrome-soft bg-chrome-soft/10 px-3 py-1.5 font-mono text-[11px] font-semibold text-chrome-soft"
            >
              <span>💰 My own money</span>
              <span className="text-[13px] leading-none">{quickExpanded ? "▴" : "▾"}</span>
            </button>
            {quickExpanded && (
              <div className="flex gap-2">
                <button type="button" onClick={() => quickPersonal("in")} className={chipCls(!!from && isPersonal(from))}>
                  + Add money in
                </button>
                <button type="button" onClick={() => quickPersonal("out")} className={chipCls(!!to && isPersonal(to))}>
                  − Take money out
                </button>
              </div>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="field-label">Amount</span>
            <div className="flex items-baseline gap-1.5 rounded border border-[#d8cdb0] bg-[#fffdf7] px-3.5 py-2.5 focus-within:border-chrome">
              <span className="font-mono text-lg text-ink-soft">৳</span>
              <input
                className="min-w-0 flex-1 border-none bg-transparent font-mono text-2xl font-semibold text-ink outline-none"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </label>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-ink-soft">
                Date — <strong className="text-ink">{date === today() ? "Today" : date}</strong>
              </span>
              <button type="button" onClick={() => setDateExpanded((v) => !v)} className="font-mono text-[11px] text-chrome-soft underline decoration-dotted">
                {dateExpanded ? "Hide" : "Change date"}
              </button>
            </div>
            {dateExpanded && (
              <input type="date" className="field-input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="field-label">Note (optional)</span>
            <input className="field-input" placeholder="e.g. petty cash top-up" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>

          <div className={`rounded-md px-3.5 py-2.5 font-mono text-[12px] leading-relaxed ${canSubmit ? "bg-paper-dim text-ink" : "bg-paper-dim text-ink-soft italic"}`}>
            {previewText()}
            {canSubmit && (
              <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-chrome-soft">
                {kind === "transfer" ? "Internal transfer" : kind === "injection" ? "Owner capital — injection" : "Owner capital — withdrawal"}
              </span>
            )}
          </div>

          {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
          <button className="btn btn-primary" disabled={!canSubmit || saving} onClick={submit}>
            {saving ? "Saving…" : submitLabel()}
          </button>
        </div>
      )}

      {(view === "pick-from" || view === "pick-to") && (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 px-5 pb-3 pt-2">
            <button onClick={() => setView("form")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f0ebe0] font-mono text-sm text-ink-soft transition-colors active:bg-[#e8e0cc]">
              ‹
            </button>
            <p className="font-display text-[16px] font-bold text-ink">Choose account</p>
          </div>
          <div className="px-5 pb-2">
            <input
              className="field-input"
              placeholder="Search accounts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col pb-4">
            {pickerGroups(view === "pick-from" ? "from" : "to").map((g) => (
              <div key={g.label}>
                <p className="sticky top-0 bg-paper px-5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
                  {g.label}
                </p>
                {g.items.map((a) => {
                  const current = view === "pick-from" ? from : to;
                  const selected = current?.id === a.id;
                  const personal = isPersonal(a);
                  return (
                    <button
                      key={String(a.id)}
                      type="button"
                      onClick={() => pick(view === "pick-from" ? "from" : "to", a)}
                      className={`flex w-full items-center justify-between border-b border-dotted border-[#d8cdb0] px-5 py-3 text-left transition-colors active:bg-paper-dim ${selected ? "bg-action/10" : ""}`}
                    >
                      <span className={`font-mono text-sm ${personal ? "text-chrome-soft" : selected ? "font-semibold text-ink" : "text-ink"}`}>
                        {a.name}
                        {personal && <span className="ml-1 text-ink-soft opacity-70">({a.sub})</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!personal && <span className="font-mono text-[11px] text-ink-soft">{bdt(a.current_balance)}</span>}
                        {selected && <span className="font-mono text-[11px] text-chrome">✓</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
