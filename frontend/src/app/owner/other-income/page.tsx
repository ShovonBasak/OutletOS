"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useOwnerOutlet } from "@/lib/ownerOutlet";
import { bdt, shortDate, today } from "@/lib/format";
import { type Period, monthLabel, rangeFor } from "@/lib/periodFilter";
import AccountPicker from "@/components/AccountPicker";
import SearchablePicker from "@/components/SearchablePicker";
import { BottomSheet } from "@/components/BottomSheet";
import FilterChip from "@/components/FilterChip";
import BreakdownList from "@/components/BreakdownList";
import type { FinancialAccount, OtherIncome, OtherIncomeCategory, OtherIncomeSummary, Paginated } from "@/lib/types";

const PAGE_SIZE = 10;

export default function OtherIncomePage() {
  const { selectedOutlet } = useOwnerOutlet();
  const outlet = selectedOutlet?.id;
  const [entries, setEntries] = useState<OtherIncome[]>([]);
  const [categories, setCategories] = useState<OtherIncomeCategory[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [summary, setSummary] = useState<OtherIncomeSummary | null>(null);

  // Date-range filters
  const [period, setPeriod] = useState<Period>("month");
  const [monthValue, setMonthValue] = useState(today().slice(0, 7));
  const [custom, setCustom] = useState({ from: today().slice(0, 8) + "01", to: today() });

  // Category/account filters — live inside a sheet instead of dropdowns
  // sitting inline; chips below the trigger show what's active.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");

  // Pagination — the list is server-paginated, so totals can no longer be
  // summed from `entries`; they come from /other-incomes/summary/ instead.
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // Add-entry form (lives inside the popup sheet)
  const [sheetOpen, setSheetOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [entryDate, setEntryDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function filterParams(): Record<string, string> {
    const range = rangeFor(period, monthValue, custom);
    const p: Record<string, string> = { date_from: range.from, date_to: range.to };
    if (outlet) p.outlet = String(outlet);
    if (catFilter) p.category = catFilter;
    if (accountFilter) p.account = accountFilter;
    return p;
  }

  async function refreshEntries(p = page) {
    if (!outlet) return;
    const params = new URLSearchParams({ ...filterParams(), page: String(p), page_size: String(PAGE_SIZE) });
    const d = await api<Paginated<OtherIncome>>(`/other-incomes/?${params}`);
    setEntries(d.results);
    setTotalCount(d.count);
    setHasNext(!!d.next);
    setHasPrev(!!d.previous);
  }

  async function refreshSummary() {
    if (!outlet) return;
    const params = new URLSearchParams(filterParams());
    const d = await api<OtherIncomeSummary>(`/other-incomes/summary/?${params}`);
    setSummary(d);
  }

  async function refreshCategories() {
    const d = await api<Paginated<OtherIncomeCategory>>("/income-categories/");
    setCategories(d.results);
    if (!category && d.results[0]) setCategory(String(d.results[0].id));
  }

  async function refreshAccounts() {
    const d = await api<Paginated<FinancialAccount>>("/financial-accounts/");
    setAccounts(d.results);
    if (!accountId) {
      const def = d.results.find((a) => a.is_primary_cash) ?? d.results[0];
      if (def) setAccountId(String(def.id));
    }
  }

  useEffect(() => {
    refreshCategories();
    refreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any filter change goes back to page 1 — a stale page number from a wider
  // result set could otherwise land past the end of a narrower one.
  useEffect(() => {
    setPage(1);
    refreshEntries(1);
    refreshSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, monthValue, custom, catFilter, accountFilter, outlet]);

  function goToPage(p: number) {
    setPage(p);
    refreshEntries(p);
  }

  const periodLabel = useMemo(() => {
    if (period === "today") return "Today";
    if (period === "week") return "Last 7 days";
    if (period === "month") return monthLabel(monthValue);
    return `${shortDate(custom.from)} – ${shortDate(custom.to)}`;
  }, [period, monthValue, custom]);

  const byAccount = useMemo(
    () => (summary?.by_account ?? []).map((r) => ({ name: r.name, amount: Number(r.amount) })),
    [summary]
  );
  const byCategory = useMemo(
    () => (summary?.by_category ?? []).map((r) => ({ name: r.name, amount: Number(r.amount) })),
    [summary]
  );
  const total = Number(summary?.total ?? 0);
  const entryCount = summary?.count ?? 0;

  const accountFilterName = accounts.find((a) => String(a.id) === accountFilter)?.name;
  const catFilterName = categories.find((c) => String(c.id) === catFilter)?.name;
  const activeFilterCount = [accountFilter, catFilter].filter(Boolean).length;

  function clearAllFilters() {
    setAccountFilter(""); setCatFilter("");
  }

  function openAddSheet() {
    setError(null);
    setSheetOpen(true);
  }

  function closeSheet() {
    setError(null);
    setSheetOpen(false);
  }

  async function saveEntry() {
    if (!category || !amount) { setError("Category and amount are required."); return; }
    if (!outlet) { setError("No outlet selected."); return; }
    setSaving(true); setError(null);
    try {
      await api("/other-incomes/", {
        method: "POST",
        body: JSON.stringify({
          outlet,
          date: entryDate,
          category: Number(category),
          amount,
          received_into_account: accountId ? Number(accountId) : null,
          description: note,
        }),
      });
      setAmount(""); setNote("");
      setSheetOpen(false);
      await Promise.all([refreshEntries(1), refreshSummary()]);
      setPage(1);
    } catch { setError("Could not save entry."); }
    finally { setSaving(false); }
  }

  async function deleteEntry(id: number) {
    try {
      await api(`/other-incomes/${id}/`, { method: "DELETE" });
      setDeleteConfirm(null);
      // Deleting the last row on a page past the first bounces back one page
      // instead of showing an empty page with "Prev" still clickable.
      const landingPage = entries.length === 1 && page > 1 ? page - 1 : page;
      setPage(landingPage);
      await Promise.all([refreshEntries(landingPage), refreshSummary()]);
    } catch {
      setError("Could not delete entry.");
      setDeleteConfirm(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">

      {/* ── period selector ── */}
      <div className="flex flex-col gap-3">
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
              {p === "today" ? "Today" : p === "week" ? "Last 7 days" : p === "month" ? "Month" : "Custom"}
            </button>
          ))}
        </div>

        {period === "month" && (
          <label className="field max-w-[220px]">
            <span className="field-label">Select month</span>
            <input
              type="month"
              className="field-input"
              value={monthValue}
              max={today().slice(0, 7)}
              onChange={(e) => setMonthValue(e.target.value)}
            />
          </label>
        )}

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
      </div>

      {/* ── total hero ── */}
      <div className="ticket flex flex-col gap-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Total other income · {periodLabel}
        </p>
        <p className="font-display text-[34px] font-bold leading-none text-leaf-deep">
          {bdt(total)}
        </p>
        <p className="mt-1 font-mono text-[11px] text-ink-soft">
          {entryCount} entr{entryCount === 1 ? "y" : "ies"}
        </p>
      </div>

      {/* ── breakdown — organized as two short ranked lists with proportion
          bars, instead of an unbounded row of wrapping chips ── */}
      {(byAccount.length > 0 || byCategory.length > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BreakdownList title="By account" rows={byAccount} total={total} />
          <BreakdownList title="By category" rows={byCategory} total={total} />
        </div>
      )}

      {/* ── entries ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="sec">Other income</h2>
          <button
            onClick={openAddSheet}
            className="rounded-lg border border-chrome/40 bg-chrome/5 px-3 py-1.5 font-mono text-[11px] text-chrome hover:bg-chrome/10"
          >
            + Add income entry
          </button>
        </div>

        {/* filters — one trigger instead of dropdowns sitting inline; active
            picks show as removable chips underneath. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFiltersOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[#d8cdb0] bg-[#fffdf7] px-3 py-1.5 font-mono text-[11px] text-ink-soft hover:border-chrome-soft hover:text-chrome-soft"
          >
            <span>⚙ Filters</span>
            {activeFilterCount > 0 && (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-chrome font-mono text-[9px] font-bold text-paper">
                {activeFilterCount}
              </span>
            )}
          </button>
          {accountFilterName && (
            <FilterChip label={accountFilterName} onClear={() => setAccountFilter("")} />
          )}
          {catFilterName && (
            <FilterChip label={catFilterName} onClear={() => setCatFilter("")} />
          )}
          {activeFilterCount > 0 && (
            <button onClick={clearAllFilters} className="font-mono text-[10px] text-ink-soft underline">
              Clear all
            </button>
          )}
        </div>

        {/* Mobile: one card per entry — the table needs horizontal scroll
            to see every column, which doesn't work well on a phone. */}
        <div className="flex flex-col gap-2.5 sm:hidden">
          {entries.map((e) => (
            <div key={e.id} className="flex flex-col gap-2 rounded-lg border-2 border-[#d8cdb0] bg-[#fffdf7] px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display text-[14px] font-bold text-ink">{e.category_name}</p>
                  <p className="font-mono text-[10px] text-ink-soft">{shortDate(e.date)}</p>
                </div>
                <p className="shrink-0 font-mono text-[16px] font-bold text-leaf-deep">+{bdt(e.amount)}</p>
              </div>
              {e.description && (
                <p className="font-mono text-[11px] text-ink-soft">{e.description}</p>
              )}
              <div className="flex items-center justify-between border-t border-dotted border-[#d8cdb0] pt-2">
                <span className="font-mono text-[11px] font-semibold text-ink-soft">
                  {e.received_into_account_name ?? "—"}
                </span>
                {deleteConfirm === e.id ? (
                  <span className="flex items-center gap-3">
                    <button
                      className="font-mono text-[11px] font-bold text-chili-deep"
                      onClick={() => deleteEntry(e.id)}
                    >Confirm delete</button>
                    <button
                      className="font-mono text-[11px] text-ink-soft"
                      onClick={() => setDeleteConfirm(null)}
                    >Cancel</button>
                  </span>
                ) : (
                  <button
                    className="font-mono text-[11px] text-chili opacity-60"
                    onClick={() => setDeleteConfirm(e.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
          {entries.length === 0 && (
            <p className="py-6 text-center font-mono text-xs text-ink-soft">No entries in this period.</p>
          )}
        </div>

        {/* Desktop/tablet: full table. */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="datatable min-w-[520px]">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Received into</th>
                <th className="text-right">Amount</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{shortDate(e.date)}</td>
                  <td>{e.category_name}</td>
                  <td className="text-ink-soft">{e.received_into_account_name ?? "—"}</td>
                  <td className="text-right font-mono text-leaf-deep">+{bdt(e.amount)}</td>
                  <td className="text-ink-soft">{e.description || "—"}</td>
                  <td>
                    {deleteConfirm === e.id ? (
                      <span className="flex items-center gap-1">
                        <button
                          className="font-mono text-[10px] text-chili-deep font-bold"
                          onClick={() => deleteEntry(e.id)}
                        >Confirm</button>
                        <button
                          className="font-mono text-[10px] text-ink-soft"
                          onClick={() => setDeleteConfirm(null)}
                        >Cancel</button>
                      </span>
                    ) : (
                      <button
                        className="font-mono text-[11px] text-chili opacity-40 hover:opacity-100"
                        title="Delete"
                        onClick={() => setDeleteConfirm(e.id)}
                      >✕</button>
                    )}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={6} className="text-ink-soft">No entries in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination — 10 per page; totals above come from the server, not
            from summing these rows. */}
        {(hasPrev || hasNext) && (
          <div className="flex items-center justify-between border-t border-[#d8cdb0] pt-3">
            <p className="font-mono text-[10px] text-ink-soft">
              {totalCount} total · page {page} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}
            </p>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost !px-3 !py-1 font-mono text-[11px] disabled:opacity-40"
                disabled={!hasPrev}
                onClick={() => goToPage(page - 1)}
              >
                ← Prev
              </button>
              <button
                className="btn btn-ghost !px-3 !py-1 font-mono text-[11px] disabled:opacity-40"
                disabled={!hasNext}
                onClick={() => goToPage(page + 1)}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── filters sheet ── */}
      <BottomSheet open={filtersOpen} onClose={() => setFiltersOpen(false)}>
        <div className="flex flex-col gap-4 px-5 pb-6">
          <div className="flex items-center justify-between">
            <p className="font-display text-[16px] font-bold text-ink">Filters</p>
            {activeFilterCount > 0 && (
              <button onClick={clearAllFilters} className="font-mono text-[11px] text-chili-deep">
                Clear all
              </button>
            )}
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Account</span>
            <AccountPicker
              accounts={accounts}
              value={accountFilter}
              onChange={setAccountFilter}
              placeholder="All accounts"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Category</span>
            <SearchablePicker
              options={categories}
              value={catFilter}
              onChange={setCatFilter}
              placeholder="All categories"
              searchPlaceholder="Search categories…"
            />
          </label>
          <button className="btn btn-primary" onClick={() => setFiltersOpen(false)}>Done</button>
        </div>
      </BottomSheet>

      {/* ── add income entry — popup, triggered by "+ Add income entry" above ── */}
      <BottomSheet open={sheetOpen} onClose={closeSheet}>
        <div className="flex flex-col gap-4 px-5 pb-6">
          <p className="font-display text-[16px] font-bold text-ink">Add income entry</p>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Date</span>
            <input type="date" className="field-input" value={entryDate} max={today()}
              onChange={(e) => setEntryDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Category</span>
            <SearchablePicker
              options={categories}
              value={category}
              onChange={setCategory}
              placeholder="Select category"
              searchPlaceholder="Search categories…"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Amount (৳)</span>
            <input className="field-input" type="number" min="0" value={amount}
              onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Received into</span>
            <AccountPicker
              accounts={accounts}
              value={accountId}
              onChange={setAccountId}
              showBalance
              placeholder="Select account"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="field-label">Note</span>
            <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={saving} onClick={saveEntry}>
              {saving ? "Saving…" : "Save entry"}
            </button>
            <button className="btn btn-ghost flex-1" disabled={saving} onClick={closeSheet}>Cancel</button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
