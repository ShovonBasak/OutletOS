"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import AccountPicker from "@/components/AccountPicker";
import SearchablePicker from "@/components/SearchablePicker";
import type { CostCategory, FinancialAccountName, Paginated } from "@/lib/types";

export default function StaffAddExpense() {
  const router = useRouter();
  const { user } = useAuth();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [categories, setCategories] = useState<CostCategory[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<CostCategory>>("/cost-categories/").then((d) => {
      setCategories(d.results);
      if (d.results[0]) setCategory(String(d.results[0].id));
    });
    api<Paginated<FinancialAccountName>>("/financial-accounts/").then((d) => {
      // Staff sees names only — backend returns FinancialAccountNameSerializer
      const active = d.results.filter((a) => a.is_active);
      setAccounts(active);
      const def = active.find((a) => a.is_primary_cash) ?? active[0];
      if (def) setAccountId(String(def.id));
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
          outlet,
          date: opDate,
          category: Number(category),
          amount,
          paid_from_account: accountId ? Number(accountId) : null,
          description: note,
        }),
      });
      router.push("/staff");
    } catch {
      setError("Could not save expense.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Add expense</h1>
        <p className="text-xs text-ink-soft">Logged for {shortDate(opDate)}</p>
      </div>

      <div className="field">
        <span className="field-label">Category</span>
        <SearchablePicker
          options={categories}
          value={category}
          onChange={setCategory}
          searchPlaceholder="Search categories…"
        />
      </div>

      <label className="field">
        <span className="field-label">Amount (৳)</span>
        <input
          className="field-input"
          type="number"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <div className="field">
        <span className="field-label">Paid from</span>
        <AccountPicker
          accounts={accounts}
          value={accountId}
          onChange={setAccountId}
        />
      </div>

      <label className="field">
        <span className="field-label">Note</span>
        <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save expense"}
      </button>
    </div>
  );
}
