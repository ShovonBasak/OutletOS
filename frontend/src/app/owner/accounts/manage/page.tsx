"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useOwnerOutlet } from "@/lib/ownerOutlet";
import { bdt, today } from "@/lib/format";
import { ACCOUNT_TYPE_COLOR, ACCOUNT_TYPE_ICON, ACCOUNT_TYPE_LABELS, BALANCE_COLOR } from "@/lib/accountTypes";
import { BottomSheet } from "@/components/BottomSheet";
import type { AccountType, FinancialAccount, Paginated } from "@/lib/types";

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "MOBILE_WALLET", label: "Mobile Wallet" },
  { value: "BANK", label: "Bank" },
  { value: "SUPPLIER_CREDIT", label: "Supplier Credit" },
];

export default function ManageAccountsPage() {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [editingAccount, setEditingAccount] = useState<FinancialAccount | null>(null);
  const [newAccType, setNewAccType] = useState<AccountType>("CASH");
  const [newAccName, setNewAccName] = useState("");
  const [newAccProvider, setNewAccProvider] = useState("");
  const [newAccOpening, setNewAccOpening] = useState("0");
  const [newAccOpeningDate, setNewAccOpeningDate] = useState(today());
  const [accSaving, setAccSaving] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  // The account form has no per-account outlet picker — new accounts are
  // created under whichever outlet the Owner currently has selected.
  const { selectedOutlet } = useOwnerOutlet();
  const outletId = selectedOutlet?.id ?? null;

  function startEdit(a: FinancialAccount) {
    setEditingAccount(a);
    setNewAccType(a.account_type as AccountType);
    setNewAccName(a.name);
    setNewAccProvider(a.provider);
    setNewAccOpening(a.opening_balance);
    setNewAccOpeningDate(a.opening_balance_date);
    setAccError(null);
    setSheetOpen(true);
  }

  function openAddSheet() {
    cancelEdit();
    setSheetOpen(true);
  }

  function cancelEdit() {
    setEditingAccount(null);
    setNewAccName("");
    setNewAccProvider("");
    setNewAccOpening("0");
    setNewAccOpeningDate(today());
    setNewAccType("CASH");
    setAccError(null);
  }

  function closeSheet() {
    cancelEdit();
    setSheetOpen(false);
  }

  async function loadAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
    setAccounts(d.results);
  }

  async function saveAccount() {
    if (!newAccName.trim()) { setAccError("Account name is required."); return; }
    if (!editingAccount && !outletId) { setAccError("No outlet found for your organization yet."); return; }
    setAccSaving(true); setAccError(null);
    try {
      const body = {
        account_type: newAccType,
        name: newAccName.trim(),
        provider: newAccProvider.trim(),
        opening_balance: newAccOpening || "0",
        opening_balance_date: newAccOpeningDate,
        outlet: outletId,
      };
      if (editingAccount) {
        await api(`/financial-accounts/${editingAccount.id}/`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/financial-accounts/", { method: "POST", body: JSON.stringify(body) });
      }
      cancelEdit();
      setSheetOpen(false);
      await loadAccounts();
    } catch {
      setAccError("Could not save account.");
    } finally {
      setAccSaving(false);
    }
  }

  async function deleteAccount(id: number) {
    try {
      await api(`/financial-accounts/${id}/`, { method: "DELETE" });
      setDeleteConfirm(null);
      await loadAccounts();
    } catch {
      setAccError("Cannot delete — account has transactions linked to it.");
      setDeleteConfirm(null);
    }
  }

  async function toggleActive(a: FinancialAccount) {
    try {
      await api(`/financial-accounts/${a.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !a.is_active }),
      });
      await loadAccounts();
    } catch {
      setAccError("Could not update account.");
    }
  }

  async function setPrimaryCash(a: FinancialAccount) {
    try {
      await api(`/financial-accounts/${a.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ is_primary_cash: true }),
      });
      await loadAccounts();
    } catch {
      setAccError("Could not set primary cash account.");
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/owner/accounts" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Accounts
      </Link>

      <div>
        <h1 className="font-display text-xl font-bold">Manage accounts</h1>
        <p className="text-xs text-ink-soft">Add, edit, deactivate, or set the primary cash account</p>
      </div>

      {/* Account list */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="sec">All accounts</h2>
          <button
            onClick={openAddSheet}
            className="rounded-lg border border-chrome/40 bg-chrome/5 px-3 py-1.5 font-mono text-[11px] text-chrome hover:bg-chrome/10"
          >
            + Add account
          </button>
        </div>
        {/* Mobile: one card per account — the table below needs horizontal
            scroll to see every column, which doesn't work well on a phone. */}
        <div className="flex flex-col gap-3 sm:hidden">
          {accounts.map((a) => {
            const bal = Number(a.current_balance);
            return (
              <div
                key={a.id}
                className={`flex flex-col gap-2.5 rounded-lg border-2 px-4 py-3 ${ACCOUNT_TYPE_COLOR[a.account_type] ?? "border-[#d8cdb0]"} ${!a.is_active ? "opacity-60" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-base leading-none">{ACCOUNT_TYPE_ICON[a.account_type]}</span>
                    <div className="min-w-0">
                      <p className="truncate font-display text-[15px] font-bold text-ink">{a.name}</p>
                      <p className="font-mono text-[10px] text-ink-soft">
                        {ACCOUNT_TYPE_LABELS[a.account_type]}{a.provider ? ` · ${a.provider}` : ""}
                      </p>
                    </div>
                  </div>
                  <p className={`shrink-0 font-mono text-[18px] font-bold ${BALANCE_COLOR(bal)}`}>
                    {bdt(bal)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {a.is_active ? (
                    <button
                      onClick={() => toggleActive(a)}
                      className="font-mono text-[10px] px-2 py-0.5 rounded border border-leaf/40 bg-leaf/10 text-leaf-deep"
                      title="Click to deactivate"
                    >
                      Active
                    </button>
                  ) : (
                    <button
                      onClick={() => toggleActive(a)}
                      className="font-mono text-[10px] px-2 py-0.5 rounded border border-gold/60 bg-gold/10 text-gold-deep"
                      title="Click to reactivate"
                    >
                      Reactivate
                    </button>
                  )}
                  {a.account_type === "CASH" && (
                    a.is_primary_cash ? (
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-chrome/40 bg-chrome/10 text-chrome">
                        ★ Primary
                      </span>
                    ) : (
                      <button
                        onClick={() => setPrimaryCash(a)}
                        className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#d8cdb0] text-ink-soft"
                        title="Use this account as the computed cash remainder in day closing"
                      >
                        Set primary
                      </button>
                    )
                  )}
                  <span className="ml-auto font-mono text-[10px] text-ink-soft">
                    Opening {bdt(a.opening_balance)}
                  </span>
                </div>

                <div className="flex items-center gap-4 border-t border-dotted border-[#d8cdb0] pt-2">
                  <button
                    onClick={() => startEdit(a)}
                    className="font-mono text-[11px] text-gold-deep underline"
                  >
                    Edit
                  </button>
                  {deleteConfirm === a.id ? (
                    <span className="ml-auto flex items-center gap-3">
                      <button
                        className="font-mono text-[11px] font-bold text-chili-deep"
                        onClick={() => deleteAccount(a.id)}
                      >Confirm delete</button>
                      <button
                        className="font-mono text-[11px] text-ink-soft"
                        onClick={() => setDeleteConfirm(null)}
                      >Cancel</button>
                    </span>
                  ) : (
                    <button
                      className="ml-auto font-mono text-[11px] text-chili opacity-60"
                      onClick={() => setDeleteConfirm(a.id)}
                    >Delete</button>
                  )}
                </div>
              </div>
            );
          })}
          {accounts.length === 0 && (
            <p className="py-6 text-center font-mono text-xs text-ink-soft">No accounts yet.</p>
          )}
        </div>

        {/* Desktop/tablet: full table, every column visible without a mobile-only card layout. */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="datatable min-w-[640px]">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Provider</th>
                <th className="text-right">Opening</th>
                <th className="text-right">Balance</th>
                <th>Status</th>
                <th>Day-closing cash</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={!a.is_active ? "opacity-60" : ""}>
                  <td className="font-semibold">{a.name}</td>
                  <td className="text-ink-soft capitalize">{a.account_type_display}</td>
                  <td className="text-ink-soft">{a.provider || "—"}</td>
                  <td className="text-right font-mono">{bdt(a.opening_balance)}</td>
                  <td className={`text-right font-mono font-bold ${BALANCE_COLOR(Number(a.current_balance))}`}>
                    {bdt(a.current_balance)}
                  </td>
                  <td>
                    {a.is_active ? (
                      <button
                        onClick={() => toggleActive(a)}
                        className="font-mono text-[10px] px-2 py-0.5 rounded border border-leaf/40 bg-leaf/10 text-leaf-deep hover:bg-chili/10 hover:text-chili hover:border-chili/40 transition-colors"
                        title="Click to deactivate"
                      >
                        Active
                      </button>
                    ) : (
                      <button
                        onClick={() => toggleActive(a)}
                        className="font-mono text-[10px] px-2 py-0.5 rounded border border-gold/60 bg-gold/10 text-gold-deep hover:bg-leaf/10 hover:text-leaf-deep hover:border-leaf/40 transition-colors"
                        title="Click to reactivate"
                      >
                        Reactivate
                      </button>
                    )}
                  </td>
                  <td>
                    {a.account_type === "CASH" && (
                      a.is_primary_cash ? (
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-chrome/40 bg-chrome/10 text-chrome">
                          ★ Primary
                        </span>
                      ) : (
                        <button
                          onClick={() => setPrimaryCash(a)}
                          className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#d8cdb0] text-ink-soft hover:border-chrome/40 hover:text-chrome transition-colors"
                          title="Use this account as the computed cash remainder in day closing"
                        >
                          Set primary
                        </button>
                      )
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => startEdit(a)}
                      className="font-mono text-[11px] text-gold-deep underline"
                    >
                      Edit
                    </button>
                  </td>
                  <td>
                    {deleteConfirm === a.id ? (
                      <span className="flex items-center gap-1">
                        <button
                          className="font-mono text-[10px] text-chili-deep font-bold"
                          onClick={() => deleteAccount(a.id)}
                        >Confirm</button>
                        <button
                          className="font-mono text-[10px] text-ink-soft"
                          onClick={() => setDeleteConfirm(null)}
                        >Cancel</button>
                      </span>
                    ) : (
                      <button
                        className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                        onClick={() => setDeleteConfirm(a.id)}
                      >✕</button>
                    )}
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-ink-soft">No accounts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {accError && <p className="font-mono text-[11px] text-chili-deep">{accError}</p>}
      </div>

      {/* Add / edit account — popup instead of an always-visible inline
          form, triggered by "+ Add account" above or "Edit" on a row. */}
      <BottomSheet open={sheetOpen} onClose={closeSheet}>
        <div className="flex flex-col gap-4 px-5 pb-6">
          <p className="font-display text-[16px] font-bold text-ink">
            {editingAccount ? `Editing: ${editingAccount.name}` : "Add account"}
          </p>
          {editingAccount && (
            <p className="-mt-1 text-xs text-ink-soft">
              Changing the opening balance will shift the current balance by the same amount.
              Transactions are not affected.
            </p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Account type</span>
            <select
              className="field-input"
              value={newAccType}
              onChange={(e) => setNewAccType(e.target.value as AccountType)}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Account name</span>
            <input
              className="field-input"
              placeholder="e.g. Shop Cash, bKash Merchant"
              value={newAccName}
              onChange={(e) => setNewAccName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Provider (optional)</span>
            <input
              className="field-input"
              placeholder="e.g. bKash, DBBL, CP/NKG"
              value={newAccProvider}
              onChange={(e) => setNewAccProvider(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Opening balance (৳)</span>
            <input
              className="field-input"
              type="number"
              min="0"
              value={newAccOpening}
              onChange={(e) => setNewAccOpening(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Opening balance date</span>
            <input
              type="date"
              className="field-input"
              value={newAccOpeningDate}
              onChange={(e) => setNewAccOpeningDate(e.target.value)}
            />
          </label>
          {accError && <p className="font-mono text-[11px] text-chili-deep">{accError}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={accSaving} onClick={saveAccount}>
              {accSaving ? "Saving…" : editingAccount ? "Save changes" : "Add account"}
            </button>
            <button className="btn btn-ghost flex-1" disabled={accSaving} onClick={closeSheet}>Cancel</button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
