"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";
import AccountSelect from "@/components/AccountSelect";
import type { OtherIncomeCategory, FinancialAccountName, Paginated } from "@/lib/types";

export default function StaffOtherIncome() {
  const router = useRouter();
  const { user } = useAuth();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const [categories, setCategories] = useState<OtherIncomeCategory[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [category, setCategory] = useState("");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Paginated<OtherIncomeCategory>>("/income-categories/").then((d) => {
      setCategories(d.results);
      if (d.results[0]) setCategory(String(d.results[0].id));
    });
    api<Paginated<FinancialAccountName>>("/financial-accounts/").then((d) => {
      setAccounts(d.results.filter((a) => a.is_active));
      if (d.results[0]) setAccountId(String(d.results[0].id));
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
      await api("/other-incomes/", {
        method: "POST",
        body: JSON.stringify({
          outlet,
          date: opDate,
          category: Number(category),
          amount,
          received_into_account: accountId ? Number(accountId) : null,
          description: note,
        }),
      });
      router.push("/staff");
    } catch {
      setError("Could not save income entry.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Other income</h1>
        <p className="text-xs text-ink-soft">Logged for {shortDate(opDate)}</p>
      </div>

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
          placeholder=""
        />
      </label>
      <label className="field">
        <span className="field-label">Note</span>
        <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save income"}
      </button>
    </div>
  );
}
