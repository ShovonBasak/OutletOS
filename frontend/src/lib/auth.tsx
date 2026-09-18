"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearSession,
  enterStaffActingRole,
  exitStaffActingRole,
  getActingRole,
  getAccess,
  getStoredUser,
} from "./api";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isOwnerOrAdmin: boolean;
  /** Set when an Owner/Admin has toggled into "Staff view" — see enterStaffView. */
  actingAsStaff: boolean;
  /** Owner/Admin only: switch into /staff/* under their own identity, to fix a
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
  isOwnerOrAdmin: false,
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
  const isOwnerOrAdmin = user?.role === "OWNER" || user?.role === "ADMIN";

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin,
        isOwnerOrAdmin,
        actingAsStaff: actingAsStaff && isOwnerOrAdmin,
        enterStaffView,
        exitStaffView,
        setUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

function ownerOrAdminRedirect(role: Role | undefined): string {
  return role === "OWNER" || role === "ADMIN" ? "/owner" : "/staff";
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
      if (!ok) router.replace(ownerOrAdminRedirect(user.role));
    }
  }, [user, loading, actingAsStaff, router]);

  return { user, loading, isAdmin, isOwnerOrAdmin, actingAsStaff };
}
