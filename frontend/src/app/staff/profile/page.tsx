"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, resolveOutlet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Outlet, Paginated } from "@/lib/types";

export default function StaffProfile() {
  const { user, logout } = useAuth();
  const outlet = resolveOutlet(user);
  const [outletName, setOutletName] = useState("");

  // Change-password form state
  const [showForm, setShowForm] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    api<Paginated<Outlet>>("/outlets/").then((d) => {
      const o = d.results.find((x) => x.id === outlet);
      if (o) setOutletName(o.name);
    });
  }, [outlet]);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (next !== confirm) {
      setFeedback({ ok: false, msg: "New passwords do not match." });
      return;
    }
    setSaving(true);
    try {
      await api("/auth/change-password/", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setFeedback({ ok: true, msg: "Password changed successfully." });
      setCurrent(""); setNext(""); setConfirm("");
      setShowForm(false);
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      const msg = body?.error ?? "Failed to change password.";
      setFeedback({ ok: false, msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Profile</h1>
        <p className="text-xs text-ink-soft">{outletName ? `${outletName} outlet · ` : ""}Staff</p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="listrow">
          <span className="title">Name</span>
          <span className="meta">{user?.name}</span>
        </div>
        <div className="listrow">
          <span className="title">Phone</span>
          <span className="meta">{user?.phone}</span>
        </div>
      </div>

      {/* Change password */}
      <div className="ticket flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Change password</span>
          <button
            className="font-mono text-[11px] text-ink-soft underline"
            onClick={() => { setShowForm((v) => !v); setFeedback(null); }}
          >
            {showForm ? "Cancel" : "Change"}
          </button>
        </div>

        {feedback && (
          <p className={`font-mono text-xs ${feedback.ok ? "text-leaf-deep" : "text-chili-deep"}`}>
            {feedback.msg}
          </p>
        )}

        {showForm && (
          <form onSubmit={handleChangePassword} className="flex flex-col gap-2">
            <div>
              <label className="field-label">Current password</label>
              <input
                type="password"
                className="field-input"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="field-label">New password</label>
              <input
                type="password"
                className="field-input"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="field-label">Confirm new password</label>
              <input
                type="password"
                className="field-input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="btn btn-primary mt-1" disabled={saving}>
              {saving ? "Saving…" : "Update password"}
            </button>
          </form>
        )}
      </div>

      <button className="btn btn-ghost" onClick={logout}>
        Log out
      </button>
    </div>
  );
}
