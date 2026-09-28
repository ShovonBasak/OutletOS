"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CostCategory, Paginated } from "@/lib/types";

const COST_TYPES: { value: CostCategory["cost_type"]; label: string }[] = [
  { value: "FIXED", label: "Fixed" },
  { value: "VARIABLE", label: "Variable" },
  { value: "ADHOC", label: "Adhoc" },
];

export default function CostCategoriesPage() {
  const { isAdmin } = useAuth();
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<CostCategory["cost_type"]>("FIXED");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api<Paginated<CostCategory>>("/cost-categories/").then((d) => setCategories(d.results));
  }, []);

  function patch(id: number, update: Partial<CostCategory>) {
    setCategories((cs) => cs.map((c) => (c.id === id ? { ...c, ...update } : c)));
  }

  async function save(c: CostCategory) {
    setSavingId(c.id);
    try {
      const updated = await api<CostCategory>(`/cost-categories/${c.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name: c.name, cost_type: c.cost_type }),
      });
      setCategories((cs) => cs.map((x) => (x.id === updated.id ? updated : x)));
    } finally {
      setSavingId(null);
    }
  }

  async function remove(c: CostCategory) {
    if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    setDeletingId(c.id);
    try {
      await api(`/cost-categories/${c.id}/`, { method: "DELETE" });
      setCategories((cs) => cs.filter((x) => x.id !== c.id));
    } catch {
      alert("Cannot delete — this category may have existing expenses.");
    } finally {
      setDeletingId(null);
    }
  }

  async function addCategory() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const created = await api<CostCategory>("/cost-categories/", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), cost_type: newType }),
      });
      setCategories((cs) => [...cs, created]);
      setNewName("");
      setNewType("FIXED");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Cost categories group expenses in the P&amp;L report. Fixed costs repeat every period;
        variable costs scale with volume; adhoc costs are one-offs.
      </p>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[480px]">
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>
                  {isAdmin ? (
                    <input
                      className="w-full rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                      value={c.name}
                      onChange={(e) => patch(c.id, { name: e.target.value })}
                    />
                  ) : (
                    <span className="font-mono text-[11px] text-ink">{c.name}</span>
                  )}
                </td>
                <td>
                  {isAdmin ? (
                    <select
                      className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                      value={c.cost_type}
                      onChange={(e) => patch(c.id, { cost_type: e.target.value as CostCategory["cost_type"] })}
                    >
                      {COST_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-soft">{COST_TYPES.find(t => t.value === c.cost_type)?.label}</span>
                  )}
                </td>
                <td>
                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-sm bg-action px-2 py-1 text-[10px] uppercase text-gold disabled:opacity-50"
                        disabled={savingId === c.id}
                        onClick={() => save(c)}
                      >
                        {savingId === c.id ? "…" : "Save"}
                      </button>
                      <button
                        className="font-mono text-[10px] text-chili disabled:opacity-50"
                        disabled={deletingId === c.id}
                        onClick={() => remove(c)}
                      >
                        {deletingId === c.id ? "…" : "Delete"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={3} className="text-ink-soft">
                  No categories yet.
                </td>
              </tr>
            )}
            {/* Add new row — Admin only */}
            {isAdmin && (
              <tr className="border-t-2 border-[#d8cdb0]">
                <td>
                  <input
                    className="w-full rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px] placeholder:text-ink-soft/50"
                    placeholder="New category name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCategory()}
                  />
                </td>
                <td>
                  <select
                    className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as CostCategory["cost_type"])}
                  >
                    {COST_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    className="rounded-sm bg-action px-2 py-1 text-[10px] uppercase text-gold disabled:opacity-50"
                    disabled={adding || !newName.trim()}
                    onClick={addCategory}
                  >
                    {adding ? "…" : "Add"}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
