"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function AddOutletPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name) {
      setError("Outlet name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/outlets/", {
        method: "POST",
        body: JSON.stringify({ name, address, is_active: active }),
      });
      router.push("/owner/team");
    } catch {
      setError("Could not save outlet.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/owner/team" className="self-start font-mono text-[11px] text-ink-soft">
        ‹ Back to Team &amp; outlets
      </Link>

      <div className="formgrid">
        <label className="field sm:col-span-2">
          <span className="field-label">Outlet name</span>
          <input className="field-input" placeholder="e.g. CP Five Star — Uttara" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field sm:col-span-2">
          <span className="field-label">Address</span>
          <input className="field-input" placeholder="Road, area, city" value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
      </div>

      <div className="togglerow">
        <span className="text-xs">Active</span>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </div>

      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <button className="btn btn-primary w-40" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save outlet"}
      </button>
    </div>
  );
}
