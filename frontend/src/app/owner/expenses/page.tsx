"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bdt, shortDate, today } from "@/lib/format";
import type { CostCategory, Expense, Paginated } from "@/lib/types";

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [category, setCategory] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const d = await api<Paginated<Expense>>("/expenses/?outlet=1");
    setExpenses(d.results);
  }
  useEffect(() => {
    refresh();
    api<Paginated<CostCategory>>("/cost-categories/").then((d) => {
      setCategories(d.results);
      if (d.results[0]) setCategory(String(d.results[0].id));
    });
  }, []);

  async function save() {
    if (!category || !amount) {
      setError("Category and amount are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/expenses/", {
        method: "POST",
        body: JSON.stringify({
          outlet: 1,
          date: today(),
          category: Number(category),
          amount,
          description: note,
        }),
      });
      setAmount("");
      setNote("");
      await refresh();
    } catch {
      setError("Could not save expense.");
    } finally {
      setSaving(false);
    }
  }

  const rows = useMemo(
    () => expenses.filter((e) => (typeFilter ? e.cost_type === typeFilter : true)),
    [expenses, typeFilter]
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="filterbar">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="FIXED">Fixed</option>
          <option value="VARIABLE">Variable</option>
          <option value="ADHOC">Adhoc</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[560px]">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{shortDate(e.date)}</td>
                <td>{e.category_name}</td>
                <td className="capitalize">{e.cost_type.toLowerCase()}</td>
                <td>{bdt(e.amount)}</td>
                <td>{e.description || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-soft">
                  No expenses.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="sec">Add expense</h2>
        <div className="formgrid">
          <label className="field">
            <span className="field-label">Category</span>
            <select className="field-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Amount (৳)</span>
            <input className="field-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field sm:col-span-2">
            <span className="field-label">Note</span>
            <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
        <button className="btn btn-primary w-40" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save expense"}
        </button>
      </div>
    </div>
  );
}
