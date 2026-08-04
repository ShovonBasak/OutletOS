"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bdt, shortDate, today } from "@/lib/format";
import AccountSelect from "@/components/AccountSelect";
import type { CostCategory, Expense, FinancialAccount, Paginated } from "@/lib/types";

type Period = "today" | "week" | "month" | "custom";

const COST_TYPES: { value: CostCategory["cost_type"]; label: string }[] = [
  { value: "FIXED", label: "Fixed" },
  { value: "VARIABLE", label: "Variable" },
  { value: "ADHOC", label: "Adhoc" },
];

function rangeFor(period: Period, custom: { from: string; to: string }) {
  const end = today();
  if (period === "today") return { from: end, to: end };
  if (period === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: end };
  }
  if (period === "month") return { from: end.slice(0, 8) + "01", to: end };
  return custom;
}

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);

  // Filters
  const [period, setPeriod] = useState<Period>("month");
  const [custom, setCustom] = useState({ from: today().slice(0, 8) + "01", to: today() });
  const [catFilter, setCatFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");

  // Add-expense form
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [expDate, setExpDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-category form
  const [newCatName, setNewCatName] = useState("");
  const [newCatType, setNewCatType] = useState<CostCategory["cost_type"]>("ADHOC");
  const [catSaving, setCatSaving] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  const range = rangeFor(period, custom);

  async function refreshExpenses() {
    const params = new URLSearchParams({ outlet: "1", date_from: range.from, date_to: range.to });
    const d = await api<Paginated<Expense>>(`/expenses/?${params}`);
    setExpenses(d.results);
  }

  async function refreshCategories() {
    const d = await api<Paginated<CostCategory>>("/cost-categories/");
    setCategories(d.results);
    if (!category && d.results[0]) setCategory(String(d.results[0].id));
  }

  async function refreshAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/");
    setAccounts(d.results);
    if (!accountId && d.results[0]) setAccountId(String(d.results[0].id));
  }

  useEffect(() => {
    refreshCategories();
    refreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, custom]);

  const rows = useMemo(() => {
    return expenses.filter((e) => {
      if (catFilter && String(e.category) !== catFilter) return false;
      if (typeFilter && e.cost_type !== typeFilter) return false;
      if (accountFilter) {
        if (e.paid_from_account !== null) {
          if (String(e.paid_from_account) !== accountFilter) return false;
        } else {
          return false;
        }
      }
      return true;
    });
  }, [expenses, catFilter, typeFilter, accountFilter]);

  const total = useMemo(() => rows.reduce((s, e) => s + Number(e.amount), 0), [rows]);

  const byAccount = useMemo(() => {
    const m: Record<string, { name: string; amount: number }> = {};
    for (const e of rows) {
      const key = e.paid_from_account_name ?? e.source;
      const display = e.paid_from_account_name ?? (e.source === "BKASH" ? "bKash" : "Cash");
      m[key] = { name: display, amount: (m[key]?.amount ?? 0) + Number(e.amount) };
    }
    return Object.values(m);
  }, [rows]);

  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of rows) m[e.cost_type] = (m[e.cost_type] ?? 0) + Number(e.amount);
    return m;
  }, [rows]);

  async function saveExpense() {
    if (!category || !amount) { setError("Category and amount are required."); return; }
    setSaving(true); setError(null);
    try {
      await api("/expenses/", {
        method: "POST",
        body: JSON.stringify({
          outlet: 1,
          date: expDate,
          category: Number(category),
          amount,
          paid_from_account: accountId ? Number(accountId) : null,
          description: note,
        }),
      });
      setAmount(""); setNote("");
      await refreshExpenses();
    } catch { setError("Could not save expense."); }
    finally { setSaving(false); }
  }

  async function deleteExpense(id: number) {
    try {
      await api(`/expenses/${id}/`, { method: "DELETE" });
      await refreshExpenses();
    } catch { setError("Could not delete expense."); }
  }

  async function saveCategory() {
    if (!newCatName.trim()) { setCatError("Name is required."); return; }
    setCatSaving(true); setCatError(null);
    try {
      await api("/cost-categories/", { method: "POST", body: JSON.stringify({ name: newCatName.trim(), cost_type: newCatType }) });
      setNewCatName(""); setNewCatType("ADHOC");
      await refreshCategories();
    } catch { setCatError("Could not save category."); }
    finally { setCatSaving(false); }
  }

  async function deleteCategory(id: number) {
    try {
      await api(`/cost-categories/${id}/`, { method: "DELETE" });
      await refreshCategories();
    } catch { setCatError("Cannot delete — category has expenses linked to it."); }
  }

  function paidFromLabel(e: Expense): string {
    if (e.paid_from_account_name) return e.paid_from_account_name;
    return e.source === "BKASH" ? "bKash (legacy)" : "Cash (legacy)";
  }

  return (
    <div className="flex flex-col gap-6">

      {/* ── period tabs ── */}
      <div className="flex flex-wrap gap-2">
        {(["today", "week", "month", "custom"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`font-mono text-[11px] px-3 py-1.5 rounded border transition-colors ${
              period === p
                ? "bg-ink text-paper border-ink"
                : "border-[#d8cdb0] text-ink-soft hover:border-ink"
            }`}
          >
            {p === "today" ? "Today" : p === "week" ? "Last 7 days" : p === "month" ? "This month" : "Custom"}
          </button>
        ))}
      </div>

      {period === "custom" && (
        <div className="flex flex-wrap gap-3">
          <label className="field flex-1 min-w-[140px]">
            <span className="field-label">From</span>
            <input type="date" className="field-input" value={custom.from} max={custom.to}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          </label>
          <label className="field flex-1 min-w-[140px]">
            <span className="field-label">To</span>
            <input type="date" className="field-input" value={custom.to} min={custom.from}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </label>
        </div>
      )}

      {/* ── summary chips ── */}
      <div className="flex flex-wrap gap-2">
        <div className="ticket-chip">
          <span className="font-mono text-[10px] uppercase text-ink-soft">Total</span>
          <span className="font-mono text-[14px] font-bold text-ink">{bdt(total)}</span>
        </div>
        {byAccount.map((a) => (
          <div key={a.name} className="ticket-chip">
            <span className="font-mono text-[10px] uppercase text-ink-soft">{a.name}</span>
            <span className="font-mono text-[13px] font-semibold text-ink">{bdt(a.amount)}</span>
          </div>
        ))}
        {Object.entries(byType).map(([type, amt]) => (
          <div key={type} className="ticket-chip">
            <span className="font-mono text-[10px] uppercase text-ink-soft capitalize">{type.toLowerCase()}</span>
            <span className="font-mono text-[13px] font-semibold text-ink">{bdt(amt)}</span>
          </div>
        ))}
      </div>

      {/* ── filter bar ── */}
      <div className="filterbar">
        <AccountSelect
          accounts={accounts}
          value={accountFilter}
          onChange={setAccountFilter}
          placeholder="All accounts"
          className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-chrome"
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {COST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* ── expense table ── */}
      <div className="overflow-x-auto">
        <table className="datatable min-w-[600px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Type</th>
              <th>Paid from</th>
              <th className="text-right">Amount</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{shortDate(e.date)}</td>
                <td>{e.category_name}</td>
                <td className="capitalize text-ink-soft">{e.cost_type.toLowerCase()}</td>
                <td>
                  <span className="font-mono text-[11px] font-semibold text-ink-soft">
                    {paidFromLabel(e)}
                  </span>
                </td>
                <td className="text-right font-mono">{bdt(e.amount)}</td>
                <td className="text-ink-soft">{e.description || "—"}</td>
                <td>
                  <button
                    className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                    title="Delete"
                    onClick={() => deleteExpense(e.id)}
                  >✕</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-ink-soft">No expenses in this period.</td></tr>
            )}
            {rows.length > 0 && (
              <tr className="font-semibold border-t border-[#d8cdb0]">
                <td colSpan={4} className="font-mono text-[11px] text-ink-soft uppercase">Total</td>
                <td className="text-right font-mono">{bdt(total)}</td>
                <td colSpan={2}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── add expense ── */}
      <div className="flex flex-col gap-3">
        <h2 className="sec">Add expense</h2>
        <div className="formgrid">
          <label className="field">
            <span className="field-label">Date</span>
            <input type="date" className="field-input" value={expDate} max={today()}
              onChange={(e) => setExpDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Category</span>
            <select className="field-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.cost_type.toLowerCase()}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Amount (৳)</span>
            <input className="field-input" type="number" min="0" value={amount}
              onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Paid from</span>
            <AccountSelect
              accounts={accounts}
              value={accountId}
              onChange={setAccountId}
              showBalance
              placeholder=""
            />
          </label>
          <label className="field sm:col-span-2">
            <span className="field-label">Note</span>
            <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
        <button className="btn btn-primary w-40" disabled={saving} onClick={saveExpense}>
          {saving ? "Saving…" : "Save expense"}
        </button>
      </div>

      {/* ── categories ── */}
      <div className="flex flex-col gap-3">
        <h2 className="sec">Categories</h2>
        <div className="rounded border border-[#d8cdb0]">
          {categories.map((c, i) => (
            <div key={c.id} className={`flex items-center justify-between px-3 py-2 font-mono text-[12px] ${
              i < categories.length - 1 ? "border-b border-dotted border-[#d8cdb0]" : ""
            }`}>
              <span className="text-ink">{c.name}</span>
              <div className="flex items-center gap-3">
                <span className="text-ink-soft capitalize">{c.cost_type.toLowerCase()}</span>
                <button className="text-chili opacity-50 hover:opacity-100" onClick={() => deleteCategory(c.id)}>✕</button>
              </div>
            </div>
          ))}
          {categories.length === 0 && (
            <p className="px-3 py-3 font-mono text-[11px] text-ink-soft">No categories yet.</p>
          )}
        </div>

        <div className="formgrid">
          <label className="field">
            <span className="field-label">New category name</span>
            <input className="field-input" placeholder="e.g. Utilities" value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCategory(); }} />
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select className="field-input" value={newCatType}
              onChange={(e) => setNewCatType(e.target.value as CostCategory["cost_type"])}>
              {COST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>
        {catError && <p className="font-mono text-[11px] text-chili-deep">{catError}</p>}
        <button className="btn btn-primary w-44" disabled={catSaving} onClick={saveCategory}>
          {catSaving ? "Saving…" : "Add category"}
        </button>
      </div>
    </div>
  );
}
