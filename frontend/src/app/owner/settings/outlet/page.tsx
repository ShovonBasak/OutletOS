"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Outlet, Paginated } from "@/lib/types";

export default function OutletSettingsPage() {
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [draft, setDraft] = useState<{ name: string; address: string } | null>(null);
  const [outletSaving, setOutletSaving] = useState(false);
  const [flagSaving, setFlagSaving] = useState(false);

  useEffect(() => {
    api<Paginated<Outlet>>("/outlets/").then((d) => {
      const o = d.results[0] ?? null;
      setOutlet(o);
      if (o) setDraft({ name: o.name, address: o.address });
    });
  }, []);

  async function saveOutlet() {
    if (!outlet || !draft) return;
    setOutletSaving(true);
    try {
      const updated = await api<Outlet>(`/outlets/${outlet.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name, address: draft.address }),
      });
      setOutlet(updated);
      setDraft({ name: updated.name, address: updated.address });
    } finally {
      setOutletSaving(false);
    }
  }

  async function toggleFlag(field: keyof Outlet, value: boolean) {
    if (!outlet) return;
    setFlagSaving(true);
    try {
      const updated = await api<Outlet>(`/outlets/${outlet.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      setOutlet(updated);
    } finally {
      setFlagSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <section className="flex flex-col gap-3">
        <h2 className="sec">Outlet details</h2>
        {draft ? (
          <div className="flex flex-col gap-2">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                value={draft.name}
                onChange={(e) => setDraft((d) => d && { ...d, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Address</span>
              <input
                className="field-input"
                value={draft.address}
                onChange={(e) => setDraft((d) => d && { ...d, address: e.target.value })}
              />
            </label>
            <button
              className="btn btn-primary w-28 self-start"
              disabled={outletSaving || !draft.name.trim()}
              onClick={saveOutlet}
            >
              {outletSaving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <p className="font-mono text-xs text-ink-soft">Loading…</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="sec">Staff controls</h2>
        <p className="text-xs text-ink-soft">
          Feature switches that affect what staff can do during the daily flow.
        </p>
        {outlet ? (
          <div className="flex flex-col divide-y divide-[#e8e0cc] rounded border border-[#d8cdb0] bg-paper">
            <ToggleRow
              label="Date selection"
              description="Allow staff to choose which date to log operations for (useful for back-entering a missed day)."
              checked={outlet.allow_staff_date_selection}
              disabled={flagSaving}
              onChange={(v) => toggleFlag("allow_staff_date_selection", v)}
            />
          </div>
        ) : (
          <p className="font-mono text-xs text-ink-soft">Loading…</p>
        )}
      </section>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="font-mono text-[12px] font-semibold text-ink">{label}</p>
        <p className="mt-0.5 font-mono text-[10px] text-ink-soft">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
          checked ? "bg-leaf" : "bg-[#d8cdb0]"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
