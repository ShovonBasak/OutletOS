"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Brand } from "@/components/Brand";

export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useAuth();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await login(phone, password);
      setUser(user);
      router.replace(user.role === "OWNER" ? "/owner" : "/staff");
    } catch {
      setError("Invalid phone or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-chrome p-3.5 shadow-2xl">
        <div className="rounded-2xl bg-paper">
          <div className="flex items-center justify-center bg-chrome px-4 py-5 text-paper">
            <Brand />
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4 p-6">
            <h1 className="font-display text-lg font-bold">Sign in</h1>
            <label className="flex flex-col gap-1">
              <span className="field-label">Phone (login id)</span>
              <input
                className="field-input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="017…"
                autoComplete="username"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">Password</span>
              <input
                className="field-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error && <p className="font-mono text-xs text-red-deep">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <div className="rounded border border-dashed border-ink-soft/50 p-3 font-mono text-[11px] text-ink-soft">
              <p className="mb-1.5 font-semibold">Demo logins</p>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="flex items-center justify-between rounded bg-ink-soft/10 px-2.5 py-1.5 text-left active:bg-ink-soft/20"
                  onClick={() => { setPhone("01700000000"); setPassword("owner123"); }}
                >
                  <span>Owner</span>
                  <span className="text-ink-soft/60">tap to fill →</span>
                </button>
                <button
                  type="button"
                  className="flex items-center justify-between rounded bg-ink-soft/10 px-2.5 py-1.5 text-left active:bg-ink-soft/20"
                  onClick={() => { setPhone("01800000000"); setPassword("staff123"); }}
                >
                  <span>Staff</span>
                  <span className="text-ink-soft/60">tap to fill →</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
