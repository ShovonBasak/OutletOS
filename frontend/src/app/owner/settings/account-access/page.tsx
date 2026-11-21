"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { FinancialAccountName, Paginated } from "@/lib/types";

interface RoleAccess {
  id: number;
  role: string;
  account: number;
  account_name: string;
  account_type: string;
}

interface RoleDefault {
  id: number;
  role: string;
  account: number;
  account_name: string;
  account_type: string;
}

const ROLES: { value: string; label: string; description: string }[] = [
  { value: "STAFF", label: "Staff", description: "Accounts available when staff log an expense or income" },
  { value: "OWNER", label: "Owner", description: "Accounts available when owner logs an expense or income" },
];

const TYPE_LABELS: Record<string, string> = {
  CASH: "Cash",
  MOBILE_WALLET: "Mobile Wallet",
  BANK: "Bank",
  SUPPLIER_CREDIT: "Supplier Credit",
};

export default function AccountAccessPage() {
  const { isOwner, isAdmin } = useAuth();
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [access, setAccess] = useState<RoleAccess[]>([]);
  const [defaults, setDefaults] = useState<RoleDefault[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState("STAFF");

  useEffect(() => {
    Promise.all([
      api<Paginated<FinancialAccountName>>("/financial-accounts/?is_active=all"),
      api<{ results: RoleAccess[] }>("/account-role-access/"),
      api<{ results: RoleDefault[] }>("/role-default-accounts/"),
    ]).then(([accts, ra, rd]) => {
      setAccounts(accts.results);
      setAccess(ra.results);
      setDefaults(rd.results);
    });
  }, []);

  function isEnabled(role: string, accountId: number) {
    return access.some((a) => a.role === role && a.account === accountId);
  }

  function isDefault(role: string, accountId: number) {
    return defaults.some((d) => d.role === role && d.account === accountId);
  }

  function hasAnyForRole(role: string) {
    return access.some((a) => a.role === role);
  }

  // Default is independent of restriction — it can be set on any account,
  // restricted-in or not. Setting it must never create/imply a restriction
  // row: AccountRoleAccess's mere existence for a role means "restrict this
  // role to only these accounts," so a default-only row there would quietly
  // cut that role down to seeing just the one account everywhere.
  async function setDefault(role: string, accountId: number) {
    if (!isOwner) return;
    const key = `default-${role}-${accountId}`;
    setBusy(key);
    try {
      const updated = await api<RoleDefault>("/role-default-accounts/", {
        method: "POST",
        body: JSON.stringify({ role, account: accountId }),
      });
      setDefaults((prev) => [...prev.filter((d) => d.role !== role), updated]);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(role: string, accountId: number) {
    if (!isOwner) return;
    const key = `${role}-${accountId}`;
    setBusy(key);
    try {
      const existing = access.find((a) => a.role === role && a.account === accountId);
      if (existing) {
        await api(`/account-role-access/${existing.id}/`, { method: "DELETE" });
        setAccess((prev) => prev.filter((a) => a.id !== existing.id));
      } else {
        const created = await api<RoleAccess>("/account-role-access/", {
          method: "POST",
          body: JSON.stringify({ role, account: accountId }),
        });
        setAccess((prev) => [...prev, created]);
      }
    } finally {
      setBusy(null);
    }
  }

  if (!isOwner && !isAdmin) {
    return <p className="font-mono text-xs text-ink-soft">Owner access required.</p>;
  }

  const grouped = accounts.reduce<Record<string, FinancialAccountName[]>>((acc, a) => {
    if (!acc[a.account_type]) acc[a.account_type] = [];
    acc[a.account_type].push(a);
    return acc;
  }, {});

  const activeConfig = hasAnyForRole(activeRole);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs text-ink-soft">
          Restrict which accounts each role can select when logging expenses or income.
          When no accounts are pinned for a role, all active accounts are available.
          Tap ☆ on any account to make it the default — the account pre-selected
          for that role (e.g. Owner Cash for owners, Shop Cash for staff) — independent
          of whether that role's list is restricted.
        </p>
        {!isOwner && (
          <p className="mt-1 font-mono text-[10px] text-chili">
            View-only — sign in as the Owner to change this.
          </p>
        )}
      </div>

      {/* Role tabs */}
      <div className="flex gap-1 rounded-xl bg-ink-soft/10 p-1">
        {ROLES.map((r) => (
          <button
            key={r.value}
            onClick={() => setActiveRole(r.value)}
            className={`flex-1 rounded-lg py-2 font-mono text-xs font-semibold transition-colors ${
              activeRole === r.value
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-soft hover:text-ink"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Description + status */}
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[11px] text-ink-soft">
          {ROLES.find((r) => r.value === activeRole)?.description}
        </p>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
          activeConfig
            ? "bg-chrome/15 text-chrome"
            : "bg-leaf/10 text-leaf-deep"
        }`}>
          {activeConfig ? "Restricted" : "All accounts"}
        </span>
      </div>

      {/* Account list */}
      <div className="flex flex-col gap-1 rounded-xl border border-[#d8cdb0] overflow-hidden">
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type}>
            <p className="bg-[#f5f0e8] px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
              {TYPE_LABELS[type] ?? type}
            </p>
            {items.map((a) => {
              const enabled = isEnabled(activeRole, a.id);
              const isDef = isDefault(activeRole, a.id);
              const key = `${activeRole}-${a.id}`;
              const defaultKey = `default-${activeRole}-${a.id}`;
              return (
                <div
                  key={a.id}
                  className={`flex w-full items-center gap-2 border-b border-dotted border-[#e8e0cc] px-4 py-3 last:border-0 ${
                    enabled ? "bg-leaf/5" : ""
                  } ${!a.is_active ? "opacity-50" : ""}`}
                >
                  <button
                    type="button"
                    disabled={busy === defaultKey || !isOwner || isDef}
                    onClick={() => setDefault(activeRole, a.id)}
                    title={isDef ? `Default for ${activeRole.toLowerCase()}s` : `Set as default for ${activeRole.toLowerCase()}s`}
                    className={`shrink-0 font-mono text-base leading-none ${
                      isDef ? "text-gold-deep" : "text-ink-soft/30"
                    } ${isOwner && !isDef ? "active:scale-90" : "cursor-default"}`}
                  >
                    {isDef ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === key || !isOwner}
                    onClick={() => toggle(activeRole, a.id)}
                    className={`flex flex-1 items-center justify-between text-left transition-colors ${
                      !isOwner ? "cursor-default" : ""
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-mono text-sm text-ink">{a.name}</span>
                      <div className="flex items-center gap-1.5">
                        {!a.is_active && (
                          <span className="font-mono text-[9px] text-ink-soft/60 uppercase">Inactive</span>
                        )}
                        {isDef && (
                          <span className="font-mono text-[9px] text-gold-deep uppercase">
                            Default for {activeRole.toLowerCase()}s
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={`h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                      enabled
                        ? "border-leaf-deep bg-leaf-deep text-paper"
                        : "border-ink-soft/30 bg-transparent"
                    }`}>
                      {enabled && <span className="text-[10px] leading-none">✓</span>}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {accounts.length === 0 && (
          <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No accounts found.</p>
        )}
      </div>

      {activeConfig && (
        <p className="font-mono text-[10px] text-ink-soft/60">
          {access.filter((a) => a.role === activeRole).length} account(s) pinned for {activeRole.toLowerCase()}s.
          Uncheck all to restore default (all accounts visible).
        </p>
      )}
    </div>
  );
}
