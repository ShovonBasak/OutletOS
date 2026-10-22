"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FinancialAccountName, Paginated, SalesChannel } from "@/lib/types";

export default function SalesChannelsPage() {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [recomputingId, setRecomputingId] = useState<number | null>(null);
  const [recomputedMsg, setRecomputedMsg] = useState<Record<number, string>>({});

  const holdingAccounts = accounts.filter((a) => a.is_active && a.account_type === "SALES_CHANNEL");

  useEffect(() => {
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => setChannels(d.results));
    api<Paginated<FinancialAccountName>>("/financial-accounts/").then((d) => setAccounts(d.results));
  }, []);

  function patch(id: number, update: Partial<SalesChannel>) {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...update } : c)));
  }

  async function save(c: SalesChannel) {
    setSavingId(c.id);
    try {
      const updated = await api<SalesChannel>(`/sales-channels/${c.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          commission_rate: c.commission_rate,
          settlement_type: c.settlement_type,
          holding_account: c.holding_account,
        }),
      });
      patch(c.id, updated);
    } finally {
      setSavingId(null);
    }
  }

  async function toggleActive(c: SalesChannel) {
    const updated = await api<SalesChannel>(`/sales-channels/${c.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: !c.is_active }),
    });
    patch(c.id, updated);
  }

  async function recompute(c: SalesChannel) {
    setRecomputingId(c.id);
    setRecomputedMsg((m) => ({ ...m, [c.id]: "" }));
    try {
      const res = await api<{ recomputed: number }>(
        `/sales-channels/${c.id}/recompute-commissions/`,
        { method: "POST" }
      );
      setRecomputedMsg((m) => ({
        ...m,
        [c.id]: `${res.recomputed} line${res.recomputed !== 1 ? "s" : ""} updated`,
      }));
    } finally {
      setRecomputingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Commission, settlement type, and holding account for each channel. &quot;Direct to
        account&quot; means the platform pays out periodically — net revenue from each day&apos;s
        sales is held in the account you pick here until the real payout arrives (recorded in
        Settlements). &quot;Collected at outlet&quot; means the rider/customer pays on the spot and
        it&apos;s part of the day&apos;s normal cash/payments. All channels are manual entry in v1.
      </p>
      {holdingAccounts.length === 0 && (
        <p className="rounded border border-dashed border-[#d8cdb0] bg-paper-dim px-3 py-2 font-mono text-[11px] text-ink-soft">
          No &quot;Sales Channel Holding&quot; accounts yet — create one per Direct-to-account
          channel in Owner → Accounts (type: Sales Channel Holding) before picking one below.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="datatable min-w-[820px]">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Commission %</th>
              <th>Settlement</th>
              <th>Holding account</th>
              <th>Active</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <input
                    className="w-20 rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 text-center font-mono text-[11px]"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={parseFloat((Number(c.commission_rate) * 100).toFixed(4))}
                    onChange={(e) =>
                      patch(c.id, { commission_rate: (Number(e.target.value) / 100).toFixed(4) })
                    }
                  />
                </td>
                <td>
                  <select
                    className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                    value={c.settlement_type}
                    onChange={(e) =>
                      patch(c.id, {
                        settlement_type: e.target.value as SalesChannel["settlement_type"],
                      })
                    }
                  >
                    <option value="DIRECT_TO_ACCOUNT">Direct to account</option>
                    <option value="COLLECTED_AT_OUTLET">Collected at outlet</option>
                  </select>
                </td>
                <td>
                  <select
                    className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-1.5 py-1 font-mono text-[11px]"
                    value={c.holding_account ?? ""}
                    onChange={(e) =>
                      patch(c.id, {
                        holding_account: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  >
                    <option value="">— none —</option>
                    {holdingAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {c.settlement_type === "DIRECT_TO_ACCOUNT" && !c.holding_account && (
                    <p className="mt-1 font-mono text-[9px] text-chili">
                      Needed to track held revenue &amp; record settlement receipts
                    </p>
                  )}
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={c.is_active}
                    onChange={() => toggleActive(c)}
                  />
                </td>
                <td>
                  <button
                    className="rounded-sm bg-action px-2 py-1 text-[10px] uppercase text-gold disabled:opacity-50"
                    disabled={savingId === c.id}
                    onClick={() => save(c)}
                  >
                    {savingId === c.id ? "…" : "Save"}
                  </button>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-sm border border-[#d8cdb0] px-2 py-1 font-mono text-[10px] text-ink-soft hover:border-ink-soft disabled:opacity-40"
                      disabled={recomputingId === c.id || Number(c.commission_rate) === 0}
                      title="Recompute commission on all existing sales lines for this channel"
                      onClick={() => recompute(c)}
                    >
                      {recomputingId === c.id ? "…" : "Recompute history"}
                    </button>
                    {recomputedMsg[c.id] && (
                      <span className="font-mono text-[10px] text-leaf-deep">
                        ✓ {recomputedMsg[c.id]}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {channels.length === 0 && (
              <tr>
                <td colSpan={7} className="text-ink-soft">
                  No channels configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-soft">
        Use <strong>Recompute history</strong> after changing a commission rate to backfill
        commission_amount and net_amount on all existing sales lines for that channel.
      </p>

      <AddChannelForm holdingAccounts={holdingAccounts} onSaved={(c) => setChannels((cs) => [...cs, c])} />
    </div>
  );
}

function AddChannelForm({
  holdingAccounts,
  onSaved,
}: {
  holdingAccounts: FinancialAccountName[];
  onSaved: (c: SalesChannel) => void;
}) {
  const [name, setName] = useState("");
  const [commissionPct, setCommissionPct] = useState("0");
  const [settlementType, setSettlementType] = useState<SalesChannel["settlement_type"]>(
    "COLLECTED_AT_OUTLET"
  );
  const [holdingAccount, setHoldingAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const c = await api<SalesChannel>("/sales-channels/", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          commission_rate: (Number(commissionPct) / 100).toFixed(4),
          settlement_type: settlementType,
          holding_account: holdingAccount ? Number(holdingAccount) : null,
          is_active: true,
        }),
      });
      onSaved(c);
      setName("");
      setCommissionPct("0");
      setHoldingAccount("");
    } catch (e: unknown) {
      const body = (e as { body?: { name?: string[]; detail?: string } })?.body;
      setError(body?.name?.[0] ?? body?.detail ?? "Failed to add channel.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper p-3 flex flex-col gap-2">
      <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Add online sales channel</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="field col-span-2 sm:col-span-1">
          <span className="field-label">Channel name</span>
          <input
            className="field-input font-mono text-xs"
            placeholder="e.g. Shohoz Food"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Commission %</span>
          <input
            className="field-input font-mono text-sm"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={commissionPct}
            onChange={(e) => setCommissionPct(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Settlement</span>
          <select
            className="field-input"
            value={settlementType}
            onChange={(e) => setSettlementType(e.target.value as SalesChannel["settlement_type"])}
          >
            <option value="DIRECT_TO_ACCOUNT">Direct to account</option>
            <option value="COLLECTED_AT_OUTLET">Collected at outlet</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Holding account</span>
          <select
            className="field-input"
            value={holdingAccount}
            onChange={(e) => setHoldingAccount(e.target.value)}
          >
            <option value="">— none —</option>
            {holdingAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="font-mono text-[10px] text-chili">{error}</p>}
      <button className="btn btn-primary w-36 self-start" disabled={saving || !name.trim()} onClick={save}>
        {saving ? "Saving…" : "Add channel"}
      </button>
    </div>
  );
}
