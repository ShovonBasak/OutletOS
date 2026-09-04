"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bdt, shortDate, today } from "@/lib/format";
import AccountSelect from "@/components/AccountSelect";
import type {
  FinancialAccount,
  AccountTransaction,
  AccountTransfer,
  CapitalTransaction,
  Paginated,
} from "@/lib/types";

type Tab = "overview" | "transactions" | "transfer" | "capital" | "manage";

type AccountType = "BANK" | "MOBILE_WALLET" | "CASH" | "SUPPLIER_CREDIT";

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "MOBILE_WALLET", label: "Mobile Wallet" },
  { value: "BANK", label: "Bank" },
  { value: "SUPPLIER_CREDIT", label: "Supplier Credit" },
];

const ACCOUNT_TYPE_ICON: Record<string, string> = {
  BANK: "🏦",
  MOBILE_WALLET: "📱",
  CASH: "💵",
  SUPPLIER_CREDIT: "🏭",
};

const ACCOUNT_TYPE_COLOR: Record<string, string> = {
  BANK: "border-leaf/40 bg-leaf/5",
  MOBILE_WALLET: "border-gold/40 bg-gold/5",
  CASH: "border-chrome/40 bg-chrome/5",
  SUPPLIER_CREDIT: "border-chili/30 bg-chili/5",
};

const BALANCE_COLOR = (n: number) =>
  n < 0 ? "text-chili-deep" : n > 0 ? "text-leaf-deep" : "text-ink";

export default function AccountsPage() {
  const { isAdmin } = useAuth();
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [transfers, setTransfers] = useState<AccountTransfer[]>([]);
  const [capitals, setCapitals] = useState<CapitalTransaction[]>([]);
  const [tab, setTab] = useState<Tab>("overview");

  // Transaction filter
  const [filterAccount, setFilterAccount] = useState("");
  const [filterFrom, setFilterFrom] = useState(today().slice(0, 8) + "01");
  const [filterTo, setFilterTo] = useState(today());
  const [txnDeleteConfirm, setTxnDeleteConfirm] = useState<number | null>(null);
  const [txnError, setTxnError] = useState<string | null>(null);

  // Transfer form
  const [tfFrom, setTfFrom] = useState("");
  const [tfTo, setTfTo] = useState("");
  const [tfAmount, setTfAmount] = useState("");
  const [tfDate, setTfDate] = useState(today());
  const [tfNote, setTfNote] = useState("");
  const [tfSaving, setTfSaving] = useState(false);
  const [tfError, setTfError] = useState<string | null>(null);

  // Capital form
  const [capAccount, setCapAccount] = useState("");
  const [capDirection, setCapDirection] = useState<"INJECTION" | "WITHDRAWAL">("INJECTION");
  const [capAmount, setCapAmount] = useState("");
  const [capDate, setCapDate] = useState(today());
  const [capNote, setCapNote] = useState("");
  const [capSaving, setCapSaving] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);

  // Manage accounts form
  const [editingAccount, setEditingAccount] = useState<FinancialAccount | null>(null);
  const [newAccType, setNewAccType] = useState<AccountType>("CASH");
  const [newAccName, setNewAccName] = useState("");
  const [newAccProvider, setNewAccProvider] = useState("");
  const [newAccOpening, setNewAccOpening] = useState("0");
  const [newAccOpeningDate, setNewAccOpeningDate] = useState(today());
  const [accSaving, setAccSaving] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  function startEdit(a: FinancialAccount) {
    setEditingAccount(a);
    setNewAccType(a.account_type as AccountType);
    setNewAccName(a.name);
    setNewAccProvider(a.provider);
    setNewAccOpening(a.opening_balance);
    setNewAccOpeningDate(a.opening_balance_date);
    setAccError(null);
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

  async function saveAccount() {
    if (!newAccName.trim()) { setAccError("Account name is required."); return; }
    setAccSaving(true); setAccError(null);
    try {
      const body = {
        account_type: newAccType,
        name: newAccName.trim(),
        provider: newAccProvider.trim(),
        opening_balance: newAccOpening || "0",
        opening_balance_date: newAccOpeningDate,
        outlet: 1,
      };
      if (editingAccount) {
        await api(`/financial-accounts/${editingAccount.id}/`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/financial-accounts/", { method: "POST", body: JSON.stringify(body) });
      }
      cancelEdit();
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

  async function loadAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
    setAccounts(d.results);
    if (!tfFrom && d.results[0]) setTfFrom(String(d.results[0].id));
    if (!capAccount && d.results[0]) setCapAccount(String(d.results[0].id));
  }

  async function loadTransactions() {
    const params = new URLSearchParams({ date_from: filterFrom, date_to: filterTo });
    if (filterAccount) params.set("account", filterAccount);
    const d = await api<Paginated<AccountTransaction>>(`/account-transactions/?${params}&limit=100`);
    setTransactions(d.results);
  }

  async function loadTransfers() {
    const d = await api<Paginated<AccountTransfer>>("/account-transfers/?limit=50");
    setTransfers(d.results);
  }

  async function loadCapitals() {
    const d = await api<Paginated<CapitalTransaction>>("/capital-transactions/?limit=50");
    setCapitals(d.results);
  }

  async function deleteTransaction(id: number) {
    setTxnError(null);
    try {
      await api(`/account-transactions/${id}/`, { method: "DELETE" });
      setTxnDeleteConfirm(null);
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      await loadAccounts();
    } catch {
      setTxnError("Could not delete transaction.");
      setTxnDeleteConfirm(null);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (tab === "transactions") loadTransactions();
    if (tab === "transfer") { loadTransfers(); }
    if (tab === "capital") { loadCapitals(); }
  }, [tab, filterFrom, filterTo, filterAccount]);

  const totalBalance = useMemo(
    () => accounts.reduce((s, a) => s + Number(a.current_balance), 0),
    [accounts]
  );

  async function saveTransfer() {
    if (!tfFrom || !tfTo || !tfAmount) {
      setTfError("From, to account, and amount are required.");
      return;
    }
    if (tfFrom === tfTo) {
      setTfError("From and to accounts must be different.");
      return;
    }
    setTfSaving(true);
    setTfError(null);
    try {
      await api("/account-transfers/", {
        method: "POST",
        body: JSON.stringify({
          from_account: Number(tfFrom),
          to_account: Number(tfTo),
          amount: tfAmount,
          date: tfDate,
          note: tfNote,
        }),
      });
      setTfAmount("");
      setTfNote("");
      await loadAccounts();
      await loadTransfers();
    } catch {
      setTfError("Could not save transfer.");
    } finally {
      setTfSaving(false);
    }
  }

  async function deleteTransfer(id: number) {
    try {
      await api(`/account-transfers/${id}/`, { method: "DELETE" });
      await loadAccounts();
      await loadTransfers();
    } catch {
      setTfError("Could not delete transfer.");
    }
  }

  async function saveCapital() {
    if (!capAccount || !capAmount) {
      setCapError("Account and amount are required.");
      return;
    }
    setCapSaving(true);
    setCapError(null);
    try {
      await api("/capital-transactions/", {
        method: "POST",
        body: JSON.stringify({
          account: Number(capAccount),
          direction: capDirection,
          amount: capAmount,
          date: capDate,
          note: capNote,
        }),
      });
      setCapAmount("");
      setCapNote("");
      await loadAccounts();
      await loadCapitals();
    } catch {
      setCapError("Could not save capital transaction.");
    } finally {
      setCapSaving(false);
    }
  }

  async function deleteCapital(id: number) {
    try {
      await api(`/capital-transactions/${id}/`, { method: "DELETE" });
      await loadAccounts();
      await loadCapitals();
    } catch {
      setCapError("Could not delete.");
    }
  }

  return (
    <div className="flex flex-col gap-6">

      {/* ── Account cards grouped by type ── */}
      {(["CASH", "MOBILE_WALLET", "BANK", "SUPPLIER_CREDIT"] as const)
        .map((type) => {
          const group = accounts.filter((a) => a.is_active && a.account_type === type);
          if (!group.length) return null;
          const TYPE_LABELS: Record<string, string> = {
            CASH: "Cash", MOBILE_WALLET: "Mobile Wallet", BANK: "Bank", SUPPLIER_CREDIT: "Supplier Credit",
          };
          return (
            <div key={type} className="flex flex-col gap-2">
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-ink-soft flex items-center gap-2">
                <span>{ACCOUNT_TYPE_ICON[type]}</span> {TYPE_LABELS[type]}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {group.map((a) => {
                  const bal = Number(a.current_balance);
                  return (
                    <div
                      key={a.id}
                      className={`rounded-lg border-2 px-4 py-3 flex flex-col gap-1 ${ACCOUNT_TYPE_COLOR[a.account_type] ?? "border-[#d8cdb0]"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-display text-[15px] font-bold text-ink">{a.name}</span>
                        {a.is_primary_cash && (
                          <span className="rounded bg-chrome/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-chrome">
                            primary cash
                          </span>
                        )}
                        {a.provider && (
                          <span className="ml-auto font-mono text-[10px] text-ink-soft">{a.provider}</span>
                        )}
                      </div>
                      <div className={`font-mono text-[22px] font-bold ${BALANCE_COLOR(bal)}`}>
                        {bdt(bal)}
                      </div>
                      <div className="font-mono text-[10px] text-ink-soft">
                        Opening {bdt(a.opening_balance)} · from {shortDate(a.opening_balance_date)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}


      {/* ── Net balance chip ── */}
      <div className="flex items-center gap-2">
        <div className="ticket-chip">
          <span className="font-mono text-[10px] uppercase text-ink-soft">Total across all accounts</span>
          <span className={`font-mono text-[16px] font-bold ${BALANCE_COLOR(totalBalance)}`}>
            {bdt(totalBalance)}
          </span>
        </div>
      </div>

      {/* ── Tab selector ── */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: "overview", label: "Overview" },
            { id: "transactions", label: "Transaction log" },
            { id: "transfer", label: "Transfer money" },
            { id: "capital", label: "Capital in / out" },
            { id: "manage", label: "Manage accounts" },
          ] as { id: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`font-mono text-[11px] px-3 py-1.5 rounded border transition-colors ${
              tab === t.id
                ? "bg-ink text-paper border-ink"
                : "border-[#d8cdb0] text-ink-soft hover:border-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-soft max-w-[560px]">
            Each card above shows the current running balance for that account, computed from all recorded
            transactions. Use <strong>Transaction log</strong> to see the full history, <strong>Transfer money</strong> to
            move funds between accounts, and <strong>Capital in / out</strong> to record owner injections or withdrawals.
          </p>

          <h2 className="sec">Account balances</h2>
          <div className="overflow-x-auto">
            <table className="datatable min-w-[420px]">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="text-right">Opening</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const bal = Number(a.current_balance);
                  return (
                    <tr key={a.id}>
                      <td className="font-semibold">{a.name}</td>
                      <td className="text-ink-soft capitalize">{a.account_type_display}</td>
                      <td className="text-right font-mono">{bdt(a.opening_balance)}</td>
                      <td className={`text-right font-mono font-bold ${BALANCE_COLOR(bal)}`}>
                        {bdt(bal)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-[#d8cdb0] font-semibold">
                  <td colSpan={3} className="font-mono text-[11px] uppercase text-ink-soft">Total</td>
                  <td className={`text-right font-mono font-bold ${BALANCE_COLOR(totalBalance)}`}>
                    {bdt(totalBalance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Transaction log tab ── */}
      {tab === "transactions" && (
        <div className="flex flex-col gap-4">
          <div className="filterbar flex-wrap">
            <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 font-mono text-[11px] text-ink-soft">
              From
              <input
                type="date"
                className="field-input !py-1 !text-[11px]"
                value={filterFrom}
                max={filterTo}
                onChange={(e) => setFilterFrom(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1 font-mono text-[11px] text-ink-soft">
              To
              <input
                type="date"
                className="field-input !py-1 !text-[11px]"
                value={filterTo}
                min={filterFrom}
                onChange={(e) => setFilterTo(e.target.value)}
              />
            </label>
          </div>

          {txnError && <p className="font-mono text-[11px] text-chili-deep">{txnError}</p>}
          <div className="overflow-x-auto">
            <table className="datatable min-w-[640px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="text-right">Amount</th>
                  <th>Note</th>
                  {isAdmin && <th></th>}
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => {
                  const amt = Number(t.amount);
                  return (
                    <tr key={t.id}>
                      <td>{shortDate(t.date)}</td>
                      <td className="text-ink-soft">{t.account_name}</td>
                      <td>
                        <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                          amt >= 0
                            ? "bg-leaf/10 text-leaf-deep"
                            : "bg-chili/10 text-chili-deep"
                        }`}>
                          {t.transaction_type_display}
                        </span>
                      </td>
                      <td className={`text-right font-mono font-semibold ${
                        amt >= 0 ? "text-leaf-deep" : "text-chili-deep"
                      }`}>
                        {amt >= 0 ? "+" : ""}{bdt(amt)}
                      </td>
                      <td className="text-ink-soft text-xs">{t.note || "—"}</td>
                      {isAdmin && (
                        <td>
                          {txnDeleteConfirm === t.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                className="font-mono text-[10px] text-chili-deep font-bold"
                                onClick={() => deleteTransaction(t.id)}
                              >Confirm</button>
                              <button
                                className="font-mono text-[10px] text-ink-soft"
                                onClick={() => setTxnDeleteConfirm(null)}
                              >Cancel</button>
                            </span>
                          ) : (
                            <button
                              className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                              onClick={() => setTxnDeleteConfirm(t.id)}
                            >✕</button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="text-ink-soft">No transactions in this period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Transfer money tab ── */}
      {tab === "transfer" && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h2 className="sec">Transfer between accounts</h2>
            <p className="text-xs text-ink-soft max-w-[480px]">
              Use this to move money between your own accounts — e.g. depositing cash into the bank,
              or topping up the CP/NKG supplier credit. Both accounts update automatically.
            </p>
            <div className="formgrid">
              <label className="field">
                <span className="field-label">From account</span>
                <AccountSelect accounts={accounts.filter((a) => a.is_active)} value={tfFrom} onChange={setTfFrom} showBalance placeholder="" />
              </label>
              <label className="field">
                <span className="field-label">To account</span>
                <AccountSelect accounts={accounts.filter((a) => a.is_active && String(a.id) !== tfFrom)} value={tfTo} onChange={setTfTo} showBalance />
              </label>
              <label className="field">
                <span className="field-label">Amount (৳)</span>
                <input
                  className="field-input"
                  type="number"
                  min="0"
                  value={tfAmount}
                  onChange={(e) => setTfAmount(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Date</span>
                <input
                  type="date"
                  className="field-input"
                  value={tfDate}
                  max={today()}
                  onChange={(e) => setTfDate(e.target.value)}
                />
              </label>
              <label className="field sm:col-span-2">
                <span className="field-label">Note (optional)</span>
                <input className="field-input" value={tfNote} onChange={(e) => setTfNote(e.target.value)} />
              </label>
            </div>
            {tfError && <p className="font-mono text-[11px] text-chili-deep">{tfError}</p>}
            <button className="btn btn-primary w-44" disabled={tfSaving} onClick={saveTransfer}>
              {tfSaving ? "Saving…" : "Record transfer"}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="sec">Recent transfers</h2>
            <div className="overflow-x-auto">
              <table className="datatable min-w-[480px]">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>From</th>
                    <th>To</th>
                    <th className="text-right">Amount</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id}>
                      <td>{shortDate(t.date)}</td>
                      <td>{t.from_account_name}</td>
                      <td>{t.to_account_name}</td>
                      <td className="text-right font-mono">{bdt(t.amount)}</td>
                      <td className="text-ink-soft">{t.note || "—"}</td>
                      <td>
                        <button
                          className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                          onClick={() => deleteTransfer(t.id)}
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                  {transfers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-ink-soft">No transfers yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Capital in / out tab ── */}
      {tab === "capital" && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h2 className="sec">Capital injection or owner withdrawal</h2>
            <p className="text-xs text-ink-soft max-w-[480px]">
              Capital movements cross the owner ↔ business boundary. They are not revenue or expenses —
              they only affect account balances. e.g. owner puts personal money in (injection) or
              takes a monthly draw out (withdrawal).
            </p>
            <div className="field max-w-[360px]">
              <span className="field-label">Direction</span>
              <div className="segmented mt-1">
                <button
                  className={capDirection === "INJECTION" ? "active" : ""}
                  onClick={() => setCapDirection("INJECTION")}
                >
                  ↑ Capital injection
                </button>
                <button
                  className={capDirection === "WITHDRAWAL" ? "active" : ""}
                  onClick={() => setCapDirection("WITHDRAWAL")}
                >
                  ↓ Owner withdrawal
                </button>
              </div>
            </div>
            <div className="formgrid">
              <label className="field">
                <span className="field-label">Account</span>
                <AccountSelect accounts={accounts.filter((a) => a.is_active)} value={capAccount} onChange={setCapAccount} showBalance placeholder="" />
              </label>
              <label className="field">
                <span className="field-label">Amount (৳)</span>
                <input
                  className="field-input"
                  type="number"
                  min="0"
                  value={capAmount}
                  onChange={(e) => setCapAmount(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Date</span>
                <input
                  type="date"
                  className="field-input"
                  value={capDate}
                  max={today()}
                  onChange={(e) => setCapDate(e.target.value)}
                />
              </label>
              <label className="field sm:col-span-2">
                <span className="field-label">Note (optional)</span>
                <input
                  className="field-input"
                  placeholder={capDirection === "INJECTION" ? "e.g. Personal loan to cover renovation" : "e.g. Monthly draw"}
                  value={capNote}
                  onChange={(e) => setCapNote(e.target.value)}
                />
              </label>
            </div>
            {capError && <p className="font-mono text-[11px] text-chili-deep">{capError}</p>}
            <button className="btn btn-primary w-48" disabled={capSaving} onClick={saveCapital}>
              {capSaving ? "Saving…" : capDirection === "INJECTION" ? "Record injection" : "Record withdrawal"}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="sec">Capital history</h2>
            <div className="overflow-x-auto">
              <table className="datatable min-w-[440px]">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th>Type</th>
                    <th className="text-right">Amount</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {capitals.map((c) => (
                    <tr key={c.id}>
                      <td>{shortDate(c.date)}</td>
                      <td>{c.account_name}</td>
                      <td>
                        <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                          c.direction === "INJECTION"
                            ? "bg-leaf/10 text-leaf-deep"
                            : "bg-chili/10 text-chili-deep"
                        }`}>
                          {c.direction_display}
                        </span>
                      </td>
                      <td className={`text-right font-mono font-semibold ${
                        c.direction === "INJECTION" ? "text-leaf-deep" : "text-chili-deep"
                      }`}>
                        {c.direction === "INJECTION" ? "+" : "−"}{bdt(c.amount)}
                      </td>
                      <td className="text-ink-soft">{c.note || "—"}</td>
                      <td>
                        <button
                          className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                          onClick={() => deleteCapital(c.id)}
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                  {capitals.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-ink-soft">No capital transactions yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Manage accounts tab ── */}
      {tab === "manage" && (
        <div className="flex flex-col gap-6">

          {/* Account list */}
          <div className="flex flex-col gap-3">
            <h2 className="sec">All accounts</h2>
            <div className="overflow-x-auto">
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
                          onClick={() => { setTab("manage"); startEdit(a); }}
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

          {/* Add / edit form */}
          <div className="flex flex-col gap-3">
            <h2 className="sec">
              {editingAccount ? `Editing: ${editingAccount.name}` : "Add account"}
            </h2>
            {editingAccount && (
              <p className="text-xs text-ink-soft">
                Changing the opening balance will shift the current balance by the same amount.
                Transactions are not affected.
              </p>
            )}
            <div className="formgrid">
              <label className="field">
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
              <label className="field">
                <span className="field-label">Account name</span>
                <input
                  className="field-input"
                  placeholder="e.g. Shop Cash, bKash Merchant"
                  value={newAccName}
                  onChange={(e) => setNewAccName(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Provider (optional)</span>
                <input
                  className="field-input"
                  placeholder="e.g. bKash, DBBL, CP/NKG"
                  value={newAccProvider}
                  onChange={(e) => setNewAccProvider(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Opening balance (৳)</span>
                <input
                  className="field-input"
                  type="number"
                  min="0"
                  value={newAccOpening}
                  onChange={(e) => setNewAccOpening(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Opening balance date</span>
                <input
                  type="date"
                  className="field-input"
                  value={newAccOpeningDate}
                  onChange={(e) => setNewAccOpeningDate(e.target.value)}
                />
              </label>
            </div>
            {accError && <p className="font-mono text-[11px] text-chili-deep">{accError}</p>}
            <div className="flex gap-2">
              <button className="btn btn-primary w-40" disabled={accSaving} onClick={saveAccount}>
                {accSaving ? "Saving…" : editingAccount ? "Save changes" : "Add account"}
              </button>
              {editingAccount && (
                <button className="btn btn-ghost w-28" onClick={cancelEdit}>Cancel</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
