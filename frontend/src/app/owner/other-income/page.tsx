"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bdt, shortDate, today } from "@/lib/format";
import AccountSelect from "@/components/AccountSelect";
import type { OtherIncomeCategory, OtherIncome, FinancialAccount, Paginated } from "@/lib/types";

export default function OtherIncomePage() {
  const [entries, setEntries] = useState<OtherIncome[]>([]);
  const [categories, setCategories] = useState<OtherIncomeCategory[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [catFilter, setCatFilter] = useState("");

  // Add-entry form
  const [category, setCategory] = useState<string>("");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-category form
  const [newCatName, setNewCatName] = useState("");
  const [catSaving, setCatSaving] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  async function refreshEntries() {
    const d = await api<Paginated<OtherIncome>>("/other-incomes/?outlet=1");
    setEntries(d.results);
  }

  async function refreshCategories() {
    const d = await api<Paginated<OtherIncomeCategory>>("/income-categories/");
    setCategories(d.results);
    if (!category && d.results[0]) setCategory(String(d.results[0].id));
  }

  async function refreshAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/");
    setAccounts(d.results);
    if (!accountId && d.results[0]) setAccountId(String(d.results[0].id));
  }

  useEffect(() => {
    refreshEntries();
    refreshCategories();
    refreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveEntry() {
    if (!category || !amount) {
      setError("Category and amount are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/other-incomes/", {
        method: "POST",
        body: JSON.stringify({
          outlet: 1,
          date: today(),
          category: Number(category),
          amount,
          received_into_account: accountId ? Number(accountId) : null,
          description: note,
        }),
      });
      setAmount("");
      setNote("");
      await refreshEntries();
    } catch {
      setError("Could not save entry.");
    } finally {
      setSaving(false);
    }
  }

  async function saveCategory() {
    if (!newCatName.trim()) {
      setCatError("Name is required.");
      return;
    }
    setCatSaving(true);
    setCatError(null);
    try {
      await api("/income-categories/", {
        method: "POST",
        body: JSON.stringify({ name: newCatName.trim() }),
      });
      setNewCatName("");
      await refreshCategories();
    } catch {
      setCatError("Could not save category.");
    } finally {
      setCatSaving(false);
    }
  }

  async function deleteCategory(id: number) {
    try {
      await api(`/income-categories/${id}/`, { method: "DELETE" });
      await refreshCategories();
    } catch {
      setCatError("Cannot delete — category may have entries linked to it.");
    }
  }

  const rows = useMemo(
    () => entries.filter((e) => (catFilter ? String(e.category) === catFilter : true)),
    [entries, catFilter]
  );

  return (
    <div className="flex flex-col gap-6">
      {/* ── filter bar ── */}
      <div className="filterbar">
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* ── entry table ── */}
      <div className="overflow-x-auto">
        <table className="datatable min-w-[480px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Received into</th>
              <th className="text-right">Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{shortDate(e.date)}</td>
                <td>{e.category_name}</td>
                <td className="text-ink-soft">{e.received_into_account_name ?? "—"}</td>
                <td className="text-right font-mono">{bdt(e.amount)}</td>
                <td>{e.description || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">No entries.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── add entry ── */}
      <div className="flex flex-col gap-3">
        <h2 className="sec">Add income entry</h2>
        <div className="formgrid">
          <label className="field">
            <span className="field-label">Category</span>
            <select className="field-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Amount (৳)</span>
            <input
              className="field-input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Received into</span>
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
        <button className="btn btn-primary w-40" disabled={saving} onClick={saveEntry}>
          {saving ? "Saving…" : "Save entry"}
        </button>
      </div>

      {/* ── categories ── */}
      <div className="flex flex-col gap-3">
        <h2 className="sec">Categories</h2>
        <div className="rounded border border-[#d8cdb0]">
          {categories.map((c, i) => (
            <div
              key={c.id}
              className={`flex items-center justify-between px-3 py-2 font-mono text-[12px] ${
                i < categories.length - 1 ? "border-b border-dotted border-[#d8cdb0]" : ""
              }`}
            >
              <span className="text-ink">{c.name}</span>
              <button
                className="text-chili opacity-50 hover:opacity-100"
                title="Delete category"
                onClick={() => deleteCategory(c.id)}
              >
                ✕
              </button>
            </div>
          ))}
          {categories.length === 0 && (
            <p className="px-3 py-3 font-mono text-[11px] text-ink-soft">No categories yet.</p>
          )}
        </div>

        <div className="formgrid">
          <label className="field">
            <span className="field-label">New category name</span>
            <input
              className="field-input"
              placeholder="e.g. Equipment sale"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCategory(); }}
            />
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
