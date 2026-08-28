"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Outlet, Paginated, User, Role } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function roleBadge(role: Role) {
  const cfg: Record<Role, string> = {
    STAFF: "bg-chrome/10 text-chrome border border-chrome/20",
    OWNER: "bg-gold/15 text-gold-deep border border-gold/20",
    ADMIN: "bg-chili/10 text-chili border border-chili/20",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-medium uppercase tracking-widest ${cfg[role]}`}>
      {role}
    </span>
  );
}

function fieldCls(err?: boolean) {
  return `w-full rounded border ${err ? "border-chili" : "border-[#d8cdb0]"} bg-paper px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-soft/40 focus:outline-none focus:ring-1 focus:ring-chrome/50`;
}

// ── types ─────────────────────────────────────────────────────────────────────

interface UserFormState {
  name: string;
  phone: string;
  role: Role;
  outlet: string;
  password: string;
}

const EMPTY_FORM: UserFormState = { name: "", phone: "", role: "STAFF", outlet: "", password: "" };

// ── sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft/50">{children}</p>
  );
}

function ErrorMsg({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="font-mono text-[11px] text-chili">{msg}</p>;
}

// ── UserCard ──────────────────────────────────────────────────────────────────

function UserCard({
  user,
  outlets,
  isAdmin,
  onUpdated,
}: {
  user: User;
  outlets: Outlet[];
  isAdmin: boolean;
  onUpdated: (u: User) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "pwd">("view");
  const [form, setForm] = useState<UserFormState>({
    name: user.name,
    phone: user.phone,
    role: user.role,
    outlet: user.outlet ? String(user.outlet) : "",
    password: "",
  });
  const [newPwd, setNewPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const outletName = outlets.find((o) => o.id === user.outlet)?.name ?? "—";

  async function save() {
    setErr(null);
    if (!form.name.trim()) { setErr("Name is required."); return; }
    if (!form.phone.trim()) { setErr("Phone is required."); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        outlet: form.outlet ? Number(form.outlet) : null,
      };
      if (isAdmin) body.role = form.role;
      const updated = await api<User>(`/team-users/${user.id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onUpdated(updated);
      setMode("view");
    } catch (e) {
      const msg = e instanceof ApiError && typeof e.body === "object" && e.body
        ? Object.values(e.body as Record<string, string[]>).flat().join(" ")
        : "Could not save changes.";
      setErr(msg);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    setToggling(true);
    setErr(null);
    try {
      const updated = await api<User>(`/team-users/${user.id}/toggle-active/`, { method: "POST" });
      onUpdated(updated);
    } catch {
      setErr("Could not update status.");
    } finally {
      setToggling(false);
    }
  }

  async function resetPassword() {
    setErr(null);
    if (newPwd.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setSaving(true);
    try {
      await api(`/team-users/${user.id}/reset-password/`, {
        method: "POST",
        body: JSON.stringify({ password: newPwd }),
      });
      setNewPwd("");
      setMode("view");
    } catch {
      setErr("Could not reset password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-paper transition-colors ${user.is_active ? "border-[#d8cdb0]" : "border-[#e8dfc8] bg-paper-dim opacity-75"}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-mono text-[13px] font-semibold text-ink truncate">{user.name}</p>
            {roleBadge(user.role)}
            {!user.is_active && (
              <span className="rounded-full bg-chili/10 px-2 py-0.5 font-mono text-[9px] text-chili border border-chili/20">
                Inactive
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{user.phone}</p>
          {user.role === "STAFF" && (
            <p className="font-mono text-[10px] text-ink-soft/60">{outletName}</p>
          )}
        </div>

        {/* Action buttons — view mode only */}
        {mode === "view" && (
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <button
              onClick={() => { setMode("edit"); setErr(null); }}
              className="rounded border border-[#d8cdb0] px-2.5 py-1 font-mono text-[10px] text-ink-soft hover:bg-paper-dim"
            >
              Edit
            </button>
            <button
              onClick={() => { setMode("pwd"); setErr(null); setNewPwd(""); }}
              className="rounded border border-[#d8cdb0] px-2.5 py-1 font-mono text-[10px] text-ink-soft hover:bg-paper-dim"
            >
              Reset pwd
            </button>
            <button
              disabled={toggling}
              onClick={toggleActive}
              className={`rounded border px-2.5 py-1 font-mono text-[10px] hover:bg-paper-dim disabled:opacity-50 ${
                user.is_active
                  ? "border-chili/30 text-chili"
                  : "border-leaf/30 text-leaf-deep"
              }`}
            >
              {toggling ? "…" : user.is_active ? "Deactivate" : "Activate"}
            </button>
          </div>
        )}
      </div>

      {/* Edit form */}
      {mode === "edit" && (
        <div className="border-t border-dashed border-[#e8dfc8] px-4 py-3 flex flex-col gap-2.5">
          <SectionLabel>Edit user</SectionLabel>
          <input
            className={fieldCls(!form.name.trim())}
            placeholder="Full name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className={fieldCls(!form.phone.trim())}
            placeholder="Phone number"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
          {isAdmin && (
            <select
              className={fieldCls()}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
            >
              <option value="STAFF">Staff</option>
              <option value="OWNER">Owner</option>
              <option value="ADMIN">Admin</option>
            </select>
          )}
          {(form.role === "STAFF" || !isAdmin) && (
            <select
              className={fieldCls()}
              value={form.outlet}
              onChange={(e) => setForm((f) => ({ ...f, outlet: e.target.value }))}
            >
              <option value="">— No outlet assigned —</option>
              {outlets.map((o) => (
                <option key={o.id} value={String(o.id)}>{o.name}</option>
              ))}
            </select>
          )}
          <ErrorMsg msg={err} />
          <div className="flex gap-2">
            <button
              disabled={saving}
              onClick={save}
              className="rounded-lg bg-ink px-4 py-2 font-mono text-[11px] text-paper disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              onClick={() => { setMode("view"); setErr(null); }}
              className="rounded-lg border border-[#d8cdb0] px-4 py-2 font-mono text-[11px] text-ink-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Reset password form */}
      {mode === "pwd" && (
        <div className="border-t border-dashed border-[#e8dfc8] px-4 py-3 flex flex-col gap-2.5">
          <SectionLabel>Set new password for {user.name}</SectionLabel>
          <input
            type="password"
            className={fieldCls(!!err && newPwd.length < 8)}
            placeholder="New password (min 8 chars)"
            value={newPwd}
            onChange={(e) => { setNewPwd(e.target.value); setErr(null); }}
          />
          <ErrorMsg msg={err} />
          <div className="flex gap-2">
            <button
              disabled={saving}
              onClick={resetPassword}
              className="rounded-lg bg-ink px-4 py-2 font-mono text-[11px] text-paper disabled:opacity-50"
            >
              {saving ? "Resetting…" : "Reset password"}
            </button>
            <button
              onClick={() => { setMode("view"); setErr(null); setNewPwd(""); }}
              className="rounded-lg border border-[#d8cdb0] px-4 py-2 font-mono text-[11px] text-ink-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AddUserForm ───────────────────────────────────────────────────────────────

function AddUserForm({
  outlets,
  isAdmin,
  onAdded,
  onCancel,
}: {
  outlets: Outlet[];
  isAdmin: boolean;
  onAdded: (u: User) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<UserFormState>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!form.name.trim()) { setErr("Name is required."); return; }
    if (!form.phone.trim()) { setErr("Phone is required."); return; }
    if (!form.password || form.password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        password: form.password,
        role: isAdmin ? form.role : "STAFF",
        outlet: form.outlet ? Number(form.outlet) : null,
      };
      const created = await api<User>("/team-users/", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onAdded(created);
    } catch (e) {
      const msg = e instanceof ApiError && typeof e.body === "object" && e.body
        ? Object.values(e.body as Record<string, string[]>).flat().join(" ")
        : "Could not create user.";
      setErr(msg);
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-chrome/30 bg-chrome/5 px-4 py-4 flex flex-col gap-2.5">
      <SectionLabel>New team member</SectionLabel>
      <input
        className={fieldCls(!form.name.trim() && !!err)}
        placeholder="Full name"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
      />
      <input
        className={fieldCls(!form.phone.trim() && !!err)}
        placeholder="Phone number (used to log in)"
        value={form.phone}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
      />
      <input
        type="password"
        className={fieldCls(!!err && form.password.length < 8)}
        placeholder="Initial password (min 8 chars)"
        value={form.password}
        onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
      />
      {isAdmin && (
        <select
          className={fieldCls()}
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
        >
          <option value="STAFF">Staff</option>
          <option value="OWNER">Owner</option>
          <option value="ADMIN">Admin</option>
        </select>
      )}
      {(form.role === "STAFF" || !isAdmin) && (
        <select
          className={fieldCls()}
          value={form.outlet}
          onChange={(e) => setForm((f) => ({ ...f, outlet: e.target.value }))}
        >
          <option value="">— No outlet assigned —</option>
          {outlets.map((o) => (
            <option key={o.id} value={String(o.id)}>{o.name}</option>
          ))}
        </select>
      )}
      <ErrorMsg msg={err} />
      <div className="flex gap-2">
        <button
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-ink px-4 py-2 font-mono text-[11px] text-paper disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create user"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-[#d8cdb0] px-4 py-2 font-mono text-[11px] text-ink-soft"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── OutletCard ────────────────────────────────────────────────────────────────

function OutletCard({
  outlet,
  onUpdated,
}: {
  outlet: Outlet;
  onUpdated: (o: Outlet) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: outlet.name, address: outlet.address });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!draft.name.trim()) { setErr("Name is required."); return; }
    setSaving(true);
    try {
      const updated = await api<Outlet>(`/outlets/${outlet.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name.trim(), address: draft.address.trim() }),
      });
      onUpdated(updated);
      setEditing(false);
    } catch {
      setErr("Could not save outlet.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#d8cdb0] bg-paper">
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[13px] font-semibold text-ink">{outlet.name}</p>
          {outlet.address && (
            <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{outlet.address}</p>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${outlet.is_active ? "bg-leaf" : "bg-chili"}`} />
            <span className="font-mono text-[10px] text-ink-soft">
              {outlet.is_active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>
        {!editing && (
          <button
            onClick={() => { setEditing(true); setDraft({ name: outlet.name, address: outlet.address }); setErr(null); }}
            className="shrink-0 rounded border border-[#d8cdb0] px-2.5 py-1 font-mono text-[10px] text-ink-soft hover:bg-paper-dim"
          >
            Edit
          </button>
        )}
      </div>

      {editing && (
        <div className="border-t border-dashed border-[#e8dfc8] px-4 py-3 flex flex-col gap-2.5">
          <SectionLabel>Edit outlet</SectionLabel>
          <input
            className={fieldCls(!draft.name.trim())}
            placeholder="Outlet name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <input
            className={fieldCls()}
            placeholder="Address (optional)"
            value={draft.address}
            onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
          />
          <ErrorMsg msg={err} />
          <div className="flex gap-2">
            <button
              disabled={saving}
              onClick={save}
              className="rounded-lg bg-ink px-4 py-2 font-mono text-[11px] text-paper disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setEditing(false); setErr(null); }}
              className="rounded-lg border border-[#d8cdb0] px-4 py-2 font-mono text-[11px] text-ink-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Paginated<User>>("/team-users/"),
      api<Paginated<Outlet>>("/outlets/"),
    ]).then(([u, o]) => {
      setUsers(u.results);
      setOutlets(o.results);
    }).finally(() => setLoading(false));
  }, []);

  function handleUserUpdated(updated: User) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
  }

  function handleUserAdded(created: User) {
    setUsers((prev) => [created, ...prev]);
    setShowAdd(false);
  }

  if (loading) {
    return <p className="font-mono text-[11px] text-ink-soft">Loading…</p>;
  }

  const activeUsers = users.filter((u) => u.is_active);
  const inactiveUsers = users.filter((u) => !u.is_active);

  return (
    <div className="flex flex-col gap-6 pb-8">

      {/* ── Team members ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-[11px] uppercase tracking-widest text-ink-soft/60">
              Team members
            </h2>
            <p className="font-mono text-[10px] text-ink-soft/40">
              {users.length} total · {activeUsers.length} active
            </p>
          </div>
          {!showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="rounded-lg border border-chrome/40 bg-chrome/5 px-3 py-1.5 font-mono text-[11px] text-chrome hover:bg-chrome/10"
            >
              + Add user
            </button>
          )}
        </div>

        {showAdd && (
          <AddUserForm
            outlets={outlets}
            isAdmin={isAdmin}
            onAdded={handleUserAdded}
            onCancel={() => setShowAdd(false)}
          />
        )}

        {/* Active users */}
        <div className="flex flex-col gap-2">
          {activeUsers.map((u) => (
            <UserCard
              key={u.id}
              user={u}
              outlets={outlets}
              isAdmin={isAdmin}
              onUpdated={handleUserUpdated}
            />
          ))}
          {activeUsers.length === 0 && !showAdd && (
            <p className="font-mono text-[11px] text-ink-soft italic">No active team members.</p>
          )}
        </div>

        {/* Inactive users — collapsed by default */}
        {inactiveUsers.length > 0 && (
          <InactiveCollapse users={inactiveUsers} outlets={outlets} isAdmin={isAdmin} onUpdated={handleUserUpdated} />
        )}
      </section>

      {/* ── Outlets ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-ink-soft/60">
            Outlets
          </h2>
          {isAdmin && (
            <a
              href="/owner/team/add-outlet"
              className="rounded-lg border border-chrome/40 bg-chrome/5 px-3 py-1.5 font-mono text-[11px] text-chrome hover:bg-chrome/10"
            >
              + Add outlet
            </a>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {outlets.map((o) => (
            <OutletCard
              key={o.id}
              outlet={o}
              onUpdated={(updated) =>
                setOutlets((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
              }
            />
          ))}
          {outlets.length === 0 && (
            <p className="font-mono text-[11px] text-ink-soft italic">No outlets found.</p>
          )}
        </div>
      </section>

    </div>
  );
}

// ── InactiveCollapse ──────────────────────────────────────────────────────────

function InactiveCollapse({
  users,
  outlets,
  isAdmin,
  onUpdated,
}: {
  users: User[];
  outlets: Outlet[];
  isAdmin: boolean;
  onUpdated: (u: User) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="self-start font-mono text-[10px] text-ink-soft/60 hover:text-ink-soft"
      >
        {open ? "▾" : "▸"} {users.length} inactive user{users.length !== 1 ? "s" : ""}
      </button>
      {open && users.map((u) => (
        <UserCard key={u.id} user={u} outlets={outlets} isAdmin={isAdmin} onUpdated={onUpdated} />
      ))}
    </div>
  );
}
