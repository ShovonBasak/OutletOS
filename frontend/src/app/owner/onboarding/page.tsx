"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, saveUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { today } from "@/lib/format";
import type { FinancialAccount, Outlet, Paginated, User } from "@/lib/types";

type Step = "loading" | "outlet" | "accounts" | "staff";

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === "object") {
    const first = Object.values(e.body as Record<string, unknown>)[0];
    return Array.isArray(first) ? String(first[0]) : String(first ?? fallback);
  }
  return fallback;
}

export default function OnboardingWizard() {
  const router = useRouter();
  const { user, setUser } = useAuth();
  const [step, setStep] = useState<Step>("loading");
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [defaultAccounts, setDefaultAccounts] = useState<FinancialAccount[]>([]);
  const [finishing, setFinishing] = useState(false);

  // Re-derive progress from the server on mount so a page refresh mid-wizard
  // resumes at the right step instead of losing local-only state.
  useEffect(() => {
    (async () => {
      const outlets = await api<Paginated<Outlet>>("/outlets/");
      const firstOutlet = outlets.results[0] ?? null;
      if (!firstOutlet) {
        setStep("outlet");
        return;
      }
      setOutlet(firstOutlet);
      const accounts = await api<Paginated<FinancialAccount>>("/financial-accounts/?is_active=all");
      const cashAccounts = accounts.results.filter((a) => a.account_type === "CASH");
      if (cashAccounts.length === 0) {
        setStep("accounts");
      } else {
        setDefaultAccounts(accounts.results);
        setStep("staff");
      }
    })();
  }, []);

  async function finishOnboarding() {
    if (!user?.organization) return;
    setFinishing(true);
    try {
      await api(`/organizations/${user.organization}/complete-onboarding/`, { method: "POST" });
      const freshUser = await api<User>("/auth/me/");
      saveUser(freshUser);
      setUser(freshUser);
      router.replace("/owner/setup");
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-md">
        <div className="mb-5 text-center">
          <h1 className="font-display text-xl font-bold text-ink">Set up your outlet</h1>
          <p className="mt-1 font-mono text-[11px] text-ink-soft">
            A few one-time steps before you're ready to go.
          </p>
        </div>

        <div className="mb-4 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          <StepDot label="Outlet" active={step === "outlet"} done={step === "accounts" || step === "staff"} />
          <span className="text-ink-soft/40">—</span>
          <StepDot label="Accounts" active={step === "accounts"} done={step === "staff"} />
          <span className="text-ink-soft/40">—</span>
          <StepDot label="Staff" active={step === "staff"} done={false} />
        </div>

        {step === "loading" && (
          <div className="ticket text-center">
            <p className="font-mono text-xs text-ink-soft">Loading…</p>
          </div>
        )}

        {step === "outlet" && (
          <OutletStep onDone={(o) => { setOutlet(o); setStep("accounts"); }} />
        )}

        {step === "accounts" && outlet && (
          <AccountsStep
            outlet={outlet}
            initialAccounts={defaultAccounts}
            onDone={(accounts) => { setDefaultAccounts(accounts); setStep("staff"); }}
          />
        )}

        {step === "staff" && outlet && (
          <StaffStep outlet={outlet} onDone={finishOnboarding} finishing={finishing} />
        )}
      </div>
    </div>
  );
}

function StepDot({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span className={done ? "text-leaf-deep" : active ? "font-bold text-chili-deep" : ""}>
      {done ? "✓ " : ""}{label}
    </span>
  );
}

// ── Step 1: Outlet (required) ────────────────────────────────────────────────

function OutletStep({ onDone }: { onDone: (outlet: Outlet) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!name.trim()) { setError("Outlet name is required."); return; }
    setBusy(true);
    setError("");
    try {
      const outlet = await api<Outlet>("/outlets/", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), address: address.trim(), is_active: true }),
      });
      onDone(outlet);
    } catch (e) {
      setError(errMsg(e, "Could not create outlet."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket flex flex-col gap-3">
      <div>
        <p className="font-display text-sm font-bold text-ink">1. Your outlet</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
          One outlet is required before anything else can be set up. You can add more later.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="field-label">Outlet name</span>
        <input
          className="field-input"
          placeholder="e.g. Golden Bucket — Main Branch"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="field-label">Address</span>
        <input
          className="field-input"
          placeholder="Road, area, city"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      {error && <p className="font-mono text-xs text-chili-deep">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        {busy ? "Creating…" : "Create outlet →"}
      </button>
    </div>
  );
}

// ── Step 2: Financial accounts (defaults required, Bank/Mobile optional) ────

function AccountsStep({
  outlet,
  initialAccounts,
  onDone,
}: {
  outlet: Outlet;
  initialAccounts: FinancialAccount[];
  onDone: (accounts: FinancialAccount[]) => void;
}) {
  const [accounts, setAccounts] = useState<FinancialAccount[]>(initialAccounts);
  const [creating, setCreating] = useState(initialAccounts.length === 0);
  const [error, setError] = useState("");
  const [showBank, setShowBank] = useState(false);
  const [showMobile, setShowMobile] = useState(false);

  useEffect(() => {
    if (accounts.length > 0) return;
    (async () => {
      try {
        const created = await api<FinancialAccount[]>("/financial-accounts/create-defaults/", {
          method: "POST",
          body: JSON.stringify({ outlet: outlet.id }),
        });
        setAccounts(created);
      } catch (e) {
        setError(errMsg(e, "Could not create default accounts."));
      } finally {
        setCreating(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet.id]);

  return (
    <div className="ticket flex flex-col gap-3">
      <div>
        <p className="font-display text-sm font-bold text-ink">2. Financial accounts</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
          Every outlet needs these three accounts to run daily closing. We create them for you.
        </p>
      </div>

      {creating ? (
        <p className="font-mono text-xs text-ink-soft">Creating default accounts…</p>
      ) : error ? (
        <p className="font-mono text-xs text-chili-deep">{error}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {accounts
            .filter((a) => ["Owner Cash", "Shop Cash", "Supplier Credit"].includes(a.name))
            .map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded bg-leaf/5 px-3 py-2">
                <span className="font-mono text-xs text-ink">
                  {a.name} {a.is_primary_cash && <span className="text-ink-soft">(primary)</span>}
                </span>
                <span className="font-mono text-xs text-leaf-deep">✓ created</span>
              </div>
            ))}
        </div>
      )}

      <div className="mt-1 flex flex-col gap-2 border-t border-dashed border-[#e8dfc8] pt-3">
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Optional</p>
        {!showBank ? (
          <button className="btn btn-ghost text-left" onClick={() => setShowBank(true)}>
            + Add a Bank account
          </button>
        ) : (
          <OptionalAccountForm
            outletId={outlet.id}
            accountType="BANK"
            label="Bank account"
            onCreated={(a) => { setAccounts((prev) => [...prev, a]); setShowBank(false); }}
            onCancel={() => setShowBank(false)}
          />
        )}
        {!showMobile ? (
          <button className="btn btn-ghost text-left" onClick={() => setShowMobile(true)}>
            + Add a Mobile Merchant account
          </button>
        ) : (
          <OptionalAccountForm
            outletId={outlet.id}
            accountType="MOBILE_WALLET"
            label="Mobile Merchant account"
            onCreated={(a) => { setAccounts((prev) => [...prev, a]); setShowMobile(false); }}
            onCancel={() => setShowMobile(false)}
          />
        )}
      </div>

      <button
        className="btn btn-primary"
        disabled={creating || accounts.length < 3}
        onClick={() => onDone(accounts)}
      >
        Continue →
      </button>
    </div>
  );
}

function OptionalAccountForm({
  outletId,
  accountType,
  label,
  onCreated,
  onCancel,
}: {
  outletId: number;
  accountType: "BANK" | "MOBILE_WALLET";
  label: string;
  onCreated: (a: FinancialAccount) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [opening, setOpening] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!name.trim()) { setError("Account name is required."); return; }
    setBusy(true);
    setError("");
    try {
      const account = await api<FinancialAccount>("/financial-accounts/", {
        method: "POST",
        body: JSON.stringify({
          account_type: accountType,
          name: name.trim(),
          provider: provider.trim(),
          opening_balance: opening || "0",
          opening_balance_date: today(),
          outlet: outletId,
        }),
      });
      onCreated(account);
    } catch (e) {
      setError(errMsg(e, "Could not create account."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-[#e8dfc8] p-3">
      <p className="font-mono text-[10px] uppercase text-ink-soft">{label}</p>
      <input
        className="field-input"
        placeholder={accountType === "BANK" ? "e.g. Dutch-Bangla Bank" : "e.g. bKash Merchant"}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="field-input"
        placeholder="Provider (optional)"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
      />
      <input
        className="field-input"
        inputMode="decimal"
        placeholder="Opening balance"
        value={opening}
        onChange={(e) => setOpening(e.target.value)}
      />
      {error && <p className="font-mono text-[11px] text-chili-deep">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary flex-1" disabled={busy} onClick={save}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button className="btn btn-ghost flex-1" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Staff (optional, skippable) ──────────────────────────────────────

function StaffStep({
  outlet,
  onDone,
  finishing,
}: {
  outlet: Outlet;
  onDone: () => void;
  finishing: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addStaff() {
    if (!name.trim() || !phone.trim() || password.length < 8) {
      setError("Name, phone, and an 8+ character password are all required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/team-users/", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(), phone: phone.trim(), password, role: "STAFF", outlet: outlet.id,
        }),
      });
      setAdded((prev) => [...prev, name.trim()]);
      setName(""); setPhone(""); setPassword("");
    } catch (e) {
      setError(errMsg(e, "Could not create staff account."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket flex flex-col gap-3">
      <div>
        <p className="font-display text-sm font-bold text-ink">3. Staff (optional)</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
          Add your staff now, or skip and do it later from Team &amp; outlets.
        </p>
      </div>

      {added.length > 0 && (
        <div className="flex flex-col gap-1">
          {added.map((n, i) => (
            <p key={i} className="font-mono text-xs text-leaf-deep">✓ {n} added</p>
          ))}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="field-label">Full name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="field-label">Phone (used to log in)</span>
        <input
          className="field-input" type="tel" inputMode="numeric"
          value={phone} onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="field-label">Initial password (min 8 chars)</span>
        <input
          className="field-input" type="password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="font-mono text-xs text-chili-deep">{error}</p>}
      <button className="btn btn-ghost" disabled={busy} onClick={addStaff}>
        {busy ? "Adding…" : "+ Add this staff member"}
      </button>

      <button className="btn btn-primary" disabled={finishing} onClick={onDone}>
        {finishing ? "Finishing…" : added.length > 0 ? "Finish setup →" : "Skip for now →"}
      </button>
    </div>
  );
}
