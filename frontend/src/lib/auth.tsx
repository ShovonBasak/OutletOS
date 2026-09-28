"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearSession, getStoredUser, getAccess,
  enterStaffActingRole, exitStaffActingRole, getActingRole,
} from "./api";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  isOwnerOrAdmin: boolean;
  /** Role.ADMIN is the cross-organization platform-admin role — distinct from
   * an org's own OWNER/ADMIN-of-their-shop concept. isAdmin above is kept for
   * backward compat; prefer this name at new call sites. ADMIN has no
   * organization/outlet of its own — it never views one tenant's data, only
   * the platform (Organizations, Tenant applications). */
  isPlatformAdmin: boolean;
  /** Set when an Owner has toggled into "Staff view" — see enterStaffView. */
  actingAsStaff: boolean;
  /** Owner only: switch into /staff/* under their own identity, to fix a
   * staff mistake. No new session/JWT — same login, just a UI-level lens. */
  enterStaffView: () => void;
  exitStaffView: () => void;
  setUser: (user: User | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  isAdmin: false,
  isOwner: false,
  isOwnerOrAdmin: false,
  isPlatformAdmin: false,
  actingAsStaff: false,
  enterStaffView: () => {},
  exitStaffView: () => {},
  setUser: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [actingAsStaff, setActingAsStaff] = useState(false);

  useEffect(() => {
    setUser(getStoredUser<User>());
    setActingAsStaff(getActingRole() === "STAFF");
    setLoading(false);
  }, []);

  const logout = () => {
    clearSession();
    setUser(null);
    setActingAsStaff(false);
    window.location.href = "/login";
  };

  const enterStaffView = () => {
    enterStaffActingRole();
    setActingAsStaff(true);
  };

  const exitStaffView = () => {
    exitStaffActingRole();
    setActingAsStaff(false);
  };

  const isAdmin = user?.role === "ADMIN";
  const isOwner = user?.role === "OWNER";
  const isOwnerOrAdmin = user?.role === "OWNER" || user?.role === "ADMIN";
  const isPlatformAdmin = isAdmin;

  return (
    <AuthContext.Provider
      value={{
        user, loading, isAdmin, isOwner, isOwnerOrAdmin, isPlatformAdmin,
        actingAsStaff: actingAsStaff && isOwner,
        enterStaffView, exitStaffView,
        setUser, logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

function roleHomeRedirect(role: Role | undefined): string {
  // ADMIN has its own section entirely, under /admin/* — never /owner/*,
  // which is tenant-specific and belongs to OWNER only.
  if (role === "ADMIN") return "/admin/organizations";
  if (role === "OWNER") return "/owner";
  return "/staff";
}

/** Guard a page to one or more roles; redirects to /login if unauthenticated.
 * An Owner/Admin who has toggled "Staff view" on is additionally allowed
 * through any guard that accepts STAFF — see AuthProvider.enterStaffView. */
export function useRequireRole(role: Role | Role[]) {
  const { user, loading, isAdmin, isOwnerOrAdmin, actingAsStaff } = useAuth();
  const router = useRouter();
  const allowed = Array.isArray(role) ? role : [role];

  useEffect(() => {
    if (loading) return;
    if (!getAccess() || !user) {
      router.replace("/login");
    } else {
      const ok = allowed.includes(user.role) || (allowed.includes("STAFF") && actingAsStaff);
      if (!ok) router.replace(roleHomeRedirect(user.role));
    }
  }, [user, loading, actingAsStaff, router]);

  return { user, loading, isAdmin, isOwnerOrAdmin, actingAsStaff };
}
