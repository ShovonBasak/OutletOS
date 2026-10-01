"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { shortDate } from "@/lib/format";
import type { Paginated, TenantApplication } from "@/lib/types";

export default function TenantApplicationsPage() {
  const [pendingApplications, setPendingApplications] = useState<TenantApplication[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const apps = await api<Paginated<TenantApplication>>("/tenant-applications/?status=PENDING");
    setPendingApplications(apps.results);
  }

  useEffect(() => {
    refresh();
  }, []);

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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Tenant applications</h1>
        <p className="text-xs text-ink-soft">New restaurant applications awaiting review</p>
      </div>

      {pendingApplications.length === 0 && (
        <div className="ticket">
          <p className="font-mono text-xs text-ink-soft">Nothing waiting — all caught up ✓</p>
        </div>
      )}

      {pendingApplications.map((app) => (
        <div key={`ta-${app.id}`} className="queue-item">
          <div className="qtop">
            <span>New tenant — {app.org_name}</span>
            <span className="stamp stamp-pending rotate-0">Pending</span>
          </div>
          <div className="qmeta">
            {app.owner_name} · {app.owner_phone} · applied {shortDate(app.submitted_at)}
            {app.org_address && <> · {app.org_address}</>}
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
