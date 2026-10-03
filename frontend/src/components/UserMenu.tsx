"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, saveUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useOwnerOutlet } from "@/lib/ownerOutlet";
import { BottomSheet } from "./BottomSheet";
import { Snackbar } from "./Snackbar";
import type { User } from "@/lib/types";

type Sheet = "closed" | "menu" | "profile" | "password" | "outlet";

function firstWord(name: string) {
  return name.split(" ")[0];
}

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({
  user,
  size = "sm",
  preview,
}: {
  user: User;
  size?: "sm" | "lg";
  preview?: string | null;
}) {
  const src = preview ?? user.avatar_url;
  const cls = size === "lg" ? "h-20 w-20 text-2xl" : "h-6 w-6 text-[10px]";
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={user.name} className={`${cls} rounded-full object-cover shrink-0`} />;
  }
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center rounded-full bg-gold font-bold text-chrome`}>
      {initials(user.name)}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function UserMenu() {
  const { user, logout, setUser, isOwner, actingAsStaff, enterStaffView } = useAuth();
  const { outlets, selectedOutlet, selectOutlet } = useOwnerOutlet();
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet>("closed");
  const [toast, setToast] = useState<string | null>(null);

  // Profile edit
  const [editName, setEditName] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password change
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);

  function showToast(text: string) {
    setToast(null);
    // defer so two rapid successes still re-trigger
    setTimeout(() => setToast(text), 50);
  }

  function close() {
    setSheet("closed");
    setAvatarFile(null);
    setAvatarPreview(null);
    setProfileErr(null);
    setPwErr(null);
  }

  function openMenu() {
    if (user) setEditName(user.name);
    setSheet("menu");
  }

  function openProfile() {
    if (user) setEditName(user.name);
    setAvatarFile(null);
    setAvatarPreview(null);
    setProfileErr(null);
    setSheet("profile");
  }

  function openPassword() {
    setCurrent(""); setNext(""); setConfirm(""); setPwErr(null);
    setSheet("password");
  }

  function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setProfileErr(null);
    try {
      const fd = new FormData();
      if (editName.trim() && editName.trim() !== user.name) fd.append("name", editName.trim());
      if (avatarFile) fd.append("avatar", avatarFile);
      if (![...fd.keys()].length) { close(); return; }

      const updated = await api<User>("/auth/me/", { method: "PATCH", body: fd });
      saveUser(updated);
      setUser(updated);
      close();
      showToast("Profile updated successfully.");
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setProfileErr(body?.error ?? "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setPwErr("New passwords don't match."); return; }
    setPwSaving(true);
    setPwErr(null);
    try {
      await api<{ detail: string }>("/auth/change-password/", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      close();
      showToast("Password changed successfully.");
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setPwErr(body?.error ?? "Failed to change password.");
    } finally {
      setPwSaving(false);
    }
  }

  if (!user) return null;

  const roleLabel =
    user.role === "ADMIN" ? "Admin" : user.role === "OWNER" ? "Owner" : "Staff";

  return (
    <>
      {/* ── Trigger chip ── */}
      <button
        onClick={openMenu}
        className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 pl-1 pr-3 py-1 transition-colors active:bg-white/20"
        aria-label="Open user menu"
      >
        <Avatar user={user} size="sm" />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-white/90">
          {firstWord(user.name)}
        </span>
      </button>

      {/* ── Snackbar (rendered outside sheet so it survives close) ── */}
      {toast && (
        <Snackbar key={toast + Date.now()} text={toast} onDone={() => setToast(null)} />
      )}

      {/* ── Bottom sheet ── */}
      <BottomSheet open={sheet !== "closed"} onClose={close}>
        {/* ══ MENU ══ */}
        {sheet === "menu" && (
          <div className="flex flex-col pb-2">
            <div className="flex items-center gap-4 px-5 pb-5 pt-3">
              <Avatar user={user} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="font-display text-[18px] font-bold text-ink leading-snug">{user.name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-chrome px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-gold font-semibold">
                    {roleLabel}
                  </span>
                  <span className="font-mono text-[11px] text-ink-soft">{user.phone}</span>
                </div>
                {(selectedOutlet?.name ?? user.outlet_name) && (
                  <p className="mt-0.5 font-mono text-[10px] text-ink-soft/60 truncate">
                    {selectedOutlet?.name ?? user.outlet_name}
                  </p>
                )}
              </div>
            </div>

            <div className="mx-5 h-px bg-[#e8e0cc]" />

            <button onClick={openProfile} className="flex items-center gap-4 px-5 py-4 text-left transition-colors active:bg-[#f5f0e8]">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#eef3ee] text-[18px]">👤</span>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] font-semibold text-ink">Edit profile</p>
                <p className="font-mono text-[10px] text-ink-soft">Update your name and photo</p>
              </div>
              <span className="text-ink-soft/40">›</span>
            </button>

            <button onClick={openPassword} className="flex items-center gap-4 px-5 py-4 text-left transition-colors active:bg-[#f5f0e8]">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#f5f0e8] text-[18px]">🔑</span>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] font-semibold text-ink">Change password</p>
                <p className="font-mono text-[10px] text-ink-soft">Update your login password</p>
              </div>
              <span className="text-ink-soft/40">›</span>
            </button>

            {isOwner && outlets.length > 1 && (
              <button onClick={() => setSheet("outlet")} className="flex items-center gap-4 px-5 py-4 text-left transition-colors active:bg-[#f5f0e8]">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-chrome/10 text-[18px]">⌂</span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[13px] font-semibold text-ink">Switch outlet</p>
                  <p className="font-mono text-[10px] text-ink-soft truncate">{selectedOutlet?.name ?? "Choose an outlet"}</p>
                </div>
                <span className="text-ink-soft/40">›</span>
              </button>
            )}

            {isOwner && !actingAsStaff && (
              <button
                onClick={() => {
                  enterStaffView();
                  close();
                  router.push("/staff");
                }}
                className="flex items-center gap-4 px-5 py-4 text-left transition-colors active:bg-[#f5f0e8]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gold/20 text-[18px]">👤</span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[13px] font-semibold text-ink">Staff view</p>
                  <p className="font-mono text-[10px] text-ink-soft">Use staff screens to fix a mistake</p>
                </div>
                <span className="text-ink-soft/40">›</span>
              </button>
            )}

            <div className="mx-5 h-px bg-[#e8e0cc]" />

            <button onClick={logout} className="flex items-center gap-4 px-5 py-4 text-left transition-colors active:bg-chili/5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-chili/10 text-[18px]">↩</span>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] font-semibold text-chili">Sign out</p>
                <p className="font-mono text-[10px] text-ink-soft">You&apos;ll need to log in again</p>
              </div>
            </button>

            <div className="h-2" />
          </div>
        )}

        {/* ══ EDIT PROFILE ══ */}
        {sheet === "profile" && (
          <div className="flex flex-col">
            <div className="flex items-center gap-3 px-5 pb-4 pt-2">
              <button onClick={() => setSheet("menu")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f0ebe0] font-mono text-sm text-ink-soft transition-colors active:bg-[#e8e0cc]">
                ‹
              </button>
              <p className="font-display text-[16px] font-bold text-ink">Edit profile</p>
            </div>

            <form onSubmit={handleProfileSave} className="flex flex-col gap-5 px-5 pb-6">
              <div className="flex flex-col items-center gap-3 pt-2">
                <button type="button" onClick={() => fileInputRef.current?.click()} className="relative rounded-full focus:outline-none">
                  <Avatar user={user} size="lg" preview={avatarPreview} />
                  <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-paper bg-chrome text-[13px] shadow">
                    📷
                  </span>
                </button>
                <p className="font-mono text-[10px] text-ink-soft/60">Tap photo to change</p>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarPick} />
              </div>

              <label className="field">
                <span className="field-label">Display name</span>
                <input className="field-input" type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Your name" required />
              </label>

              <div className="field">
                <span className="field-label">Phone (login ID)</span>
                <input className="field-input bg-ink-soft/5 text-ink-soft cursor-not-allowed" type="tel" value={user.phone} readOnly tabIndex={-1} />
              </div>

              <div className="field">
                <span className="field-label">Role</span>
                <input className="field-input bg-ink-soft/5 text-ink-soft cursor-not-allowed" value={roleLabel} readOnly tabIndex={-1} />
              </div>

              {profileErr && (
                <p className="rounded-xl bg-chili/10 px-4 py-3 font-mono text-xs text-chili-deep">{profileErr}</p>
              )}

              <button type="submit" disabled={saving || !editName.trim()} className="btn btn-primary">
                {saving ? "Saving…" : "Save changes"}
              </button>
            </form>
          </div>
        )}

        {/* ══ CHANGE PASSWORD ══ */}
        {sheet === "password" && (
          <div className="flex flex-col">
            <div className="flex items-center gap-3 px-5 pb-4 pt-2">
              <button onClick={() => setSheet("menu")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f0ebe0] font-mono text-sm text-ink-soft transition-colors active:bg-[#e8e0cc]">
                ‹
              </button>
              <p className="font-display text-[16px] font-bold text-ink">Change password</p>
            </div>

            <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 px-5 pb-6">
              <label className="field">
                <span className="field-label">Current password</span>
                <input className="field-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
              </label>
              <label className="field">
                <span className="field-label">New password</span>
                <input className="field-input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
                <span className="mt-1 font-mono text-[9px] text-ink-soft/50">At least 8 characters</span>
              </label>
              <label className="field">
                <span className="field-label">Confirm new password</span>
                <input className="field-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </label>

              {pwErr && (
                <p className="rounded-xl bg-chili/10 px-4 py-3 font-mono text-xs text-chili-deep">{pwErr}</p>
              )}

              <button type="submit" disabled={pwSaving || !current || !next || !confirm} className="btn btn-primary mt-1">
                {pwSaving ? "Saving…" : "Update password"}
              </button>
            </form>
          </div>
        )}

        {/* ══ SWITCH OUTLET ══ */}
        {sheet === "outlet" && (
          <div className="flex flex-col">
            <div className="flex items-center gap-3 px-5 pb-4 pt-2">
              <button onClick={() => setSheet("menu")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f0ebe0] font-mono text-sm text-ink-soft transition-colors active:bg-[#e8e0cc]">
                ‹
              </button>
              <p className="font-display text-[16px] font-bold text-ink">Switch outlet</p>
            </div>

            <div className="flex flex-col gap-2 px-5 pb-6">
              {outlets.map((o) => (
                <button
                  key={o.id}
                  onClick={() => { selectOutlet(o.id); close(); }}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    selectedOutlet?.id === o.id
                      ? "border-chrome/40 bg-chrome/5"
                      : "border-[#e8e0cc] active:bg-[#f5f0e8]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-[13px] font-semibold text-ink">{o.name}</p>
                    {selectedOutlet?.id === o.id && <span className="font-mono text-[10px] text-chrome">✓ current</span>}
                  </div>
                  {o.address && <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{o.address}</p>}
                </button>
              ))}
            </div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}
