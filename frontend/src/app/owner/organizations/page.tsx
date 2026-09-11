"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Organization, Paginated } from "@/lib/types";

function fieldCls(err?: boolean) {
  return `w-full rounded border ${err ? "border-chili" : "border-[#d8cdb0]"} bg-paper px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-soft/40 focus:outline-none focus:ring-1 focus:ring-chrome/50`;
}

const EMPTY_FORM = {
  name: "",
  outlet_name: "",
  owner_name: "",
  owner_phone: "",
  owner_password: "",
};

export default function OrganizationsPage() {
  const { selectedOrgId, selectOrg } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await api<Paginated<Organization>>("/organizations/");
      setOrgs(data.results);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createOrg() {
    if (!form.name || !form.owner_name || !form.owner_phone || !form.owner_password) {
      setError("Organization name and all owner fields are required.");
      return;
    }
    if (form.owner_password.length < 8) {
      setError("Owner password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/organizations/bootstrap/", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      const body = e instanceof ApiError ? e.body : null;
      let msg = "Could not create organization.";
      if (body && typeof body === "object" && "detail" in body) {
        msg = String((body as { detail: unknown }).detail);
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-[11px] text-ink-soft">
        Platform-admin only. Each organization is a fully independent franchise account —
        its own outlets, menu, ingredients, pricing, staff, and finances.
      </p>

      {loading ? (
        <p className="font-mono text-[11px] text-ink-soft">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {orgs.map((org) => (
            <div key={org.id} className="ticket flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <span className="font-display text-[14px] font-bold text-ink">{org.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-medium uppercase tracking-widest ${
                    org.is_active
                      ? "border border-green/20 bg-green/10 text-green"
                      : "border border-chili/20 bg-chili/10 text-chili"
                  }`}
                >
                  {org.is_active ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="font-mono text-[11px] text-ink-soft">
                {org.slug} · {org.outlet_count} outlet{org.outlet_count === 1 ? "" : "s"}
              </div>
              <div className="flex gap-2">
                <button
                  className={`btn ${selectedOrgId === org.id ? "btn-primary" : ""} text-[11px]`}
                  onClick={() => selectOrg(selectedOrgId === org.id ? null : org.id, org.name)}
                >
                  {selectedOrgId === org.id ? "Viewing this organization" : "View / manage"}
                </button>
              </div>
            </div>
          ))}
          {orgs.length === 0 && (
            <p className="font-mono text-[11px] text-ink-soft">No organizations yet.</p>
          )}
        </div>
      )}

      {!showForm && (
        <button className="btn btn-primary w-56" onClick={() => setShowForm(true)}>
          + New organization
        </button>
      )}

      {showForm && (
        <div className="ticket flex flex-col gap-3 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft/60">
            New organization
          </p>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-soft">Organization name</span>
            <input
              className={fieldCls()}
              placeholder="e.g. Golden Wings Franchise"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-soft">First outlet name</span>
            <input
              className={fieldCls()}
              placeholder="e.g. Golden Wings — Banani"
              value={form.outlet_name}
              onChange={(e) => setForm({ ...form, outlet_name: e.target.value })}
              autoComplete="off"
            />
          </label>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft/60">
            First owner login
          </p>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-soft">Owner name</span>
            <input
              className={fieldCls()}
              value={form.owner_name}
              onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-soft">Owner phone</span>
            <input
              className={fieldCls()}
              value={form.owner_phone}
              onChange={(e) => setForm({ ...form, owner_phone: e.target.value })}
              autoComplete="off"
              name="new-owner-phone"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] text-ink-soft">Owner password</span>
            <input
              className={fieldCls()}
              type="password"
              value={form.owner_password}
              onChange={(e) => setForm({ ...form, owner_password: e.target.value })}
              autoComplete="new-password"
              name="new-owner-password"
            />
            <span className="font-mono text-[9px] text-ink-soft/60">
              Double-check this field before creating — some browsers autofill saved
              passwords here. Confirm what&apos;s shown matches what you intend to set.
            </span>
          </label>

          {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}

          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={saving} onClick={createOrg}>
              {saving ? "Creating…" : "Create organization"}
            </button>
            <button
              className="btn"
              disabled={saving}
              onClick={() => {
                setShowForm(false);
                setError(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
