"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { StockInInvoiceRow } from "@/components/StockInInvoiceRow";
import type { DailyClosing, FinancialAccount, Paginated, StockInRecord, TenantApplication } from "@/lib/types";

export default function ApprovalsHub() {
  const { isAdmin } = useAuth();
  const [pendingStockIns, setPendingStockIns] = useState<StockInRecord[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [reviewClosings, setReviewClosings] = useState<DailyClosing[]>([]);
  const [pendingApplications, setPendingApplications] = useState<TenantApplication[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const [si, cl] = await Promise.all([
      api<Paginated<StockInRecord>>("/stock-in/?status=PENDING"),
      api<Paginated<DailyClosing>>("/daily-closings/?status=SUBMITTED"),
    ]);
    setPendingStockIns(si.results);
    setReviewClosings(cl.results);
    if (isAdmin) {
      const apps = await api<Paginated<TenantApplication>>("/tenant-applications/?status=PENDING");
      setPendingApplications(apps.results);
    }
  }
  useEffect(() => {
    refresh();
    api<Paginated<FinancialAccount>>("/financial-accounts/").then((acc) => setAccounts(acc.results));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function actStockIn(id: number, action: "approve" | "reject" | "delete", accountId?: number | null) {
    setBusy(`si-${id}`);
    try {
      if (action === "approve") {
        await api(`/stock-in/${id}/approve/`, {
          method: "POST",
          body: JSON.stringify({ paid_from_account: accountId ?? null }),
        });
      } else {
        await api(`/stock-in/${id}/${action}/`, { method: "POST" });
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function editStockInDate(id: number, newDate: string) {
    setBusy(`si-${id}`);
    try {
      await api(`/stock-in/${id}/set-date/`, {
        method: "PATCH",
        body: JSON.stringify({ stock_in_date: newDate }),
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function lockClosing(id: number) {
    setBusy(`cl-${id}`);
    try {
      await api(`/daily-closings/${id}/lock/`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function approveApplication(id: number) {
    setBusy(`ta-${id}`);
    try {
      await api(`/tenant-applications/${id}/approve/`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function rejectApplication(id: number) {
    const reason = window.prompt("Reason for rejecting (optional):") ?? "";
    setBusy(`ta-${id}`);
    try {
      await api(`/tenant-applications/${id}/reject/`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const nothing =
    pendingStockIns.length === 0 && reviewClosings.length === 0 && pendingApplications.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Approvals</h1>
          <p className="text-xs text-ink-soft">Stock in &amp; closings needing review</p>
        </div>
        <Link href="/owner/stock-in" className="font-mono text-[11px] text-gold-deep underline">
          all stock-in ›
        </Link>
      </div>

      {nothing && (
        <div className="ticket">
          <p className="font-mono text-xs text-ink-soft">Nothing waiting — all caught up ✓</p>
        </div>
      )}

      {pendingStockIns.map((r) => (
        <StockInInvoiceRow
          key={`si-${r.id}`}
          r={r}
          busy={busy === `si-${r.id}`}
          accounts={accounts}
          onAct={actStockIn}
          onEditDate={editStockInDate}
          alwaysShowActions
        />
      ))}

      {reviewClosings.map((c) => (
        <div key={`cl-${c.id}`} className="queue-item">
          <div className="qtop">
            <span>Closing — {shortDate(c.closing_date)}</span>
            <span className="stamp stamp-variance rotate-0">Variance</span>
          </div>
          <div className="qmeta">
            {c.has_flag
              ? "A stock count is flagged (walk-in derived below zero)."
              : "Submitted — awaiting owner lock."}
          </div>
          <div className="qbtns">
            <button className="approve" disabled={busy === `cl-${c.id}`} onClick={() => lockClosing(c.id)}>
              Accept &amp; lock
            </button>
            <Link href="/owner/closings" className="reject" style={{ textAlign: "center" }}>
              Review
            </Link>
          </div>
        </div>
      ))}

      {isAdmin && pendingApplications.map((app) => (
        <div key={`ta-${app.id}`} className="queue-item">
          <div className="qtop">
            <span>New tenant — {app.org_name}</span>
            <span className="stamp stamp-pending rotate-0">Pending</span>
          </div>
          <div className="qmeta">
            {app.owner_name} · {app.owner_phone} · applied {shortDate(app.submitted_at)}
          </div>
          <div className="qbtns">
            <button
              className="approve"
              disabled={busy === `ta-${app.id}`}
              onClick={() => approveApplication(app.id)}
            >
              Approve
            </button>
            <button
              className="reject"
              disabled={busy === `ta-${app.id}`}
              onClick={() => rejectApplication(app.id)}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
