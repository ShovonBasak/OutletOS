"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useOwnerOutlet } from "@/lib/ownerOutlet";
import { Stamp } from "@/components/Stamp";
import { bdt, bdt2, shortDate, today } from "@/lib/format";
import type { ChannelSettlement, FinancialAccountName, Paginated, SalesChannel } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "Received",
  PENDING: "Pending",
  PARTIAL: "Variance",
  DISPUTED: "Variance",
};

function weekAgo(d: string): string {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - 6);
  return dt.toISOString().slice(0, 10);
}

export default function SettlementsPage() {
  const { selectedOutlet } = useOwnerOutlet();
  const outlet = selectedOutlet?.id;

  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [rows, setRows] = useState<ChannelSettlement[]>([]);

  const directChannels = useMemo(
    () => channels.filter((c) => c.settlement_type === "DIRECT_TO_ACCOUNT" && c.is_active),
    [channels]
  );
  // Where a payout can actually land — real money accounts, not another
  // channel's holding account.
  const depositAccounts = useMemo(
    () => accounts.filter((a) => a.is_active && a.account_type !== "SALES_CHANNEL"),
    [accounts]
  );

  const [channelId, setChannelId] = useState("");
  const [periodStart, setPeriodStart] = useState(weekAgo(today()));
  const [periodEnd, setPeriodEnd] = useState(today());
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [receiving, setReceiving] = useState<number | null>(null);
  const [receiveAmount, setReceiveAmount] = useState("");
  const [receiveDate, setReceiveDate] = useState(today());
  const [depositAccountId, setDepositAccountId] = useState("");
  const [receiveNotes, setReceiveNotes] = useState("");
  const [recvError, setRecvError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!outlet) return;
    const d = await api<Paginated<ChannelSettlement>>(`/channel-settlements/?outlet=${outlet}`);
    setRows(d.results);
  }

  useEffect(() => {
    api<Paginated<SalesChannel>>("/sales-channels/").then((d) => setChannels(d.results));
    api<Paginated<FinancialAccountName>>("/financial-accounts/").then((d) => setAccounts(d.results));
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet]);

  useEffect(() => {
    if (!channelId && directChannels[0]) setChannelId(String(directChannels[0].id));
  }, [directChannels, channelId]);

  async function generate() {
    if (!outlet || !channelId) return;
    setGenerating(true);
    setGenError(null);
    try {
      await api<ChannelSettlement>("/channel-settlements/generate/", {
        method: "POST",
        body: JSON.stringify({
          outlet, channel: Number(channelId),
          period_start: periodStart, period_end: periodEnd,
        }),
      });
      await refresh();
    } catch (e: unknown) {
      const body = (e as { body?: { detail?: string } })?.body;
      setGenError(body?.detail ?? "Could not compute this period.");
    } finally {
      setGenerating(false);
    }
  }

  function openReceive(row: ChannelSettlement) {
    setReceiving(row.id);
    setReceiveAmount(row.expected_amount);
    setReceiveDate(today());
    setDepositAccountId(row.deposit_account ? String(row.deposit_account) : "");
    setReceiveNotes(row.notes || "");
    setRecvError(null);
  }

  async function saveReceive() {
    if (receiving == null) return;
    if (!depositAccountId) { setRecvError("Pick which account the payout landed in."); return; }
    setBusy(true);
    setRecvError(null);
    try {
      await api(`/channel-settlements/${receiving}/mark-received/`, {
        method: "POST",
        body: JSON.stringify({
          received_amount: receiveAmount,
          received_date: receiveDate,
          deposit_account: Number(depositAccountId),
          notes: receiveNotes,
        }),
      });
      setReceiving(null);
      await refresh();
    } catch (e: unknown) {
      const body = (e as { body?: { detail?: string } })?.body;
      setRecvError(body?.detail ?? "Could not record this receipt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[640px] text-xs text-ink-soft">
        For &quot;Direct to account&quot; channels, each day&apos;s net revenue is held in that
        channel&apos;s holding account until the platform actually pays out — compute what a
        period should pay, then record the real receipt once it arrives. That moves money OUT of
        the holding account into wherever it landed, dated the day it actually arrived — not the
        sales date. Configure settlement type &amp; holding account in Settings → Sales channels.
      </p>

      <div className="rounded border border-[#d8cdb0] bg-paper p-3 flex flex-col gap-2">
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Compute a settlement period
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="field col-span-2 sm:col-span-1">
            <span className="field-label">Channel</span>
            <select className="field-input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {directChannels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">From</span>
            <input type="date" className="field-input" value={periodStart} max={periodEnd}
              onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input type="date" className="field-input" value={periodEnd} min={periodStart} max={today()}
              onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" disabled={generating || !channelId} onClick={generate}>
              {generating ? "Computing…" : "Compute"}
            </button>
          </div>
        </div>
        {genError && <p className="font-mono text-[10px] text-chili">{genError}</p>}
        {directChannels.length === 0 && (
          <p className="font-mono text-[10px] text-ink-soft">
            No &quot;Direct to account&quot; channels yet — add one in Settings → Sales channels.
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="datatable min-w-[760px]">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Period</th>
              <th>Held in</th>
              <th>Expected</th>
              <th>Received</th>
              <th>Deposited to</th>
              <th>Variance</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.channel_name}</td>
                <td>{shortDate(s.period_start)} → {shortDate(s.period_end)}</td>
                <td className="font-mono text-[11px] text-ink-soft">{s.holding_account_name ?? "—"}</td>
                <td>{bdt(s.expected_amount)}</td>
                <td>{s.received_amount != null ? bdt(s.received_amount) : "—"}</td>
                <td className="font-mono text-[11px] text-ink-soft">{s.deposit_account_name ?? "—"}</td>
                <td className={
                  s.variance == null ? "text-ink-soft"
                  : Number(s.variance) === 0 ? "text-leaf-deep"
                  : "text-chili-deep font-semibold"
                }>
                  {s.variance != null ? bdt2(s.variance) : "—"}
                </td>
                <td>
                  <Stamp status={STATUS_LABEL[s.status] ?? s.status} flat />
                </td>
                <td>
                  <button
                    className="rounded-sm border border-[#d8cdb0] px-2 py-1 font-mono text-[10px] text-ink-soft hover:border-ink-soft"
                    onClick={() => openReceive(s)}
                  >
                    {s.received_amount != null ? "Edit receipt" : "Mark received"}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-ink-soft">
                  No settlement periods yet — compute one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {receiving != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setReceiving(null)}>
          <div
            className="w-full max-w-sm rounded border border-[#d8cdb0] bg-paper p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-sm font-bold text-ink">Record settlement receipt</p>
            <label className="field">
              <span className="field-label">Amount actually received (৳)</span>
              <input className="field-input" type="number" step="0.01" value={receiveAmount}
                onChange={(e) => setReceiveAmount(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Date it landed</span>
              <input type="date" className="field-input" value={receiveDate} max={today()}
                onChange={(e) => setReceiveDate(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Deposited into</span>
              <select className="field-input" value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
                <option value="">— select account —</option>
                {depositAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Notes (optional)</span>
              <input className="field-input" value={receiveNotes} onChange={(e) => setReceiveNotes(e.target.value)} />
            </label>
            {recvError && <p className="font-mono text-[10px] text-chili">{recvError}</p>}
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={busy} onClick={saveReceive}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button className="btn btn-ghost flex-1" disabled={busy} onClick={() => setReceiving(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
