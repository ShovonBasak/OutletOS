"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Brand } from "@/components/Brand";

export default function ApplyPage() {
  const [orgName, setOrgName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!orgName.trim() || !ownerName.trim() || !ownerPhone.trim() || !password) {
      setError("All fields are required.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      await api("/tenant-applications/submit/", {
        method: "POST",
        body: JSON.stringify({
          org_name: orgName.trim(),
          owner_name: ownerName.trim(),
          owner_phone: ownerPhone.trim(),
          owner_password: password,
        }),
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === "object") {
        const first = Object.values(err.body as Record<string, unknown>)[0];
        setError(Array.isArray(first) ? String(first[0]) : String(first ?? "Could not submit application."));
      } else {
        setError("Could not submit application.");
      }
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

          {submitted ? (
            <div className="ticket m-5">
              <p className="font-display text-lg font-bold text-ink">Application received ✓</p>
              <p className="mt-2 font-mono text-xs text-ink-soft">
                We&apos;ll review your application and get in touch once it&apos;s approved. You can
                sign in with the phone and password you just set as soon as that happens.
              </p>
              <Link href="/login" className="mt-4 inline-block font-mono text-xs text-gold-deep underline">
                ← Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4 p-6">
              <div>
                <h1 className="font-display text-lg font-bold">Apply for an account</h1>
                <p className="mt-1 font-mono text-[11px] text-ink-soft">
                  Set up your own outlet on CP Five Star. An admin reviews every application before
                  it goes live.
                </p>
              </div>
              <label className="flex flex-col gap-1">
                <span className="field-label">Restaurant / organization name</span>
                <input
                  className="field-input"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. Golden Bucket Fried Chicken"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Your name</span>
                <input
                  className="field-input"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  autoComplete="name"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Phone (will be your login id)</span>
                <input
                  className="field-input"
                  type="tel"
                  inputMode="numeric"
                  value={ownerPhone}
                  onChange={(e) => setOwnerPhone(e.target.value)}
                  placeholder="017…"
                  autoComplete="tel"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Password</span>
                <input
                  className="field-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Confirm password</span>
                <input
                  className="field-input"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {error && <p className="font-mono text-xs text-red-deep">{error}</p>}
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Submitting…" : "Submit application"}
              </button>
              <Link href="/login" className="text-center font-mono text-[11px] text-ink-soft underline">
                Already have an account? Sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
