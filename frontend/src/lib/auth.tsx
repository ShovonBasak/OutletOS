"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearSession, getStoredUser, getAccess,
  getSelectedOrgId, getSelectedOrgName, setSelectedOrgId,
} from "./api";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isOwnerOrAdmin: boolean;
  /** Role.ADMIN is the cross-organization platform-admin role — distinct from
   * an org's own OWNER/ADMIN-of-their-shop concept. isAdmin above is kept for
   * backward compat; prefer this name at new call sites. */
  isPlatformAdmin: boolean;
  selectedOrgId: number | null;
  selectedOrgName: string | null;
  selectOrg: (id: number | null, name?: string | null) => void;
  setUser: (user: User | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  isAdmin: false,
  isOwnerOrAdmin: false,
  isPlatformAdmin: false,
  selectedOrgId: null,
  selectedOrgName: null,
  selectOrg: () => {},
  setUser: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedOrgId, setSelectedOrgIdState] = useState<number | null>(null);
  const [selectedOrgName, setSelectedOrgNameState] = useState<string | null>(null);

  useEffect(() => {
    setUser(getStoredUser<User>());
    setSelectedOrgIdState(getSelectedOrgId());
    setSelectedOrgNameState(getSelectedOrgName());
    setLoading(false);
  }, []);

  const logout = () => {
    clearSession();
    setSelectedOrgId(null);
    setUser(null);
    window.location.href = "/login";
  };

  const selectOrg = (id: number | null, name: string | null = null) => {
    setSelectedOrgId(id, name);
    setSelectedOrgIdState(id);
    setSelectedOrgNameState(name);
  };

  const isAdmin = user?.role === "ADMIN";
  const isOwnerOrAdmin = user?.role === "OWNER" || user?.role === "ADMIN";
  const isPlatformAdmin = isAdmin;

  return (
    <AuthContext.Provider
      value={{
        user, loading, isAdmin, isOwnerOrAdmin, isPlatformAdmin,
        selectedOrgId, selectedOrgName, selectOrg, setUser, logout,
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

/** Guard a page to one or more roles; redirects to /login if unauthenticated. */
export function useRequireRole(role: Role | Role[]) {
  const { user, loading, isAdmin, isOwnerOrAdmin } = useAuth();
  const router = useRouter();
  const allowed = Array.isArray(role) ? role : [role];

  useEffect(() => {
    if (loading) return;
    if (!getAccess() || !user) {
      router.replace("/login");
    } else if (!allowed.includes(user.role)) {
      router.replace(ownerOrAdminRedirect(user.role));
    }
  }, [user, loading, router]);

  return { user, loading, isAdmin, isOwnerOrAdmin };
}
