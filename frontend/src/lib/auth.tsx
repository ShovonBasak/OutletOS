"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, getStoredUser, getAccess } from "./api";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isOwnerOrAdmin: boolean;
  setUser: (user: User | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  isAdmin: false,
  isOwnerOrAdmin: false,
  setUser: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUser(getStoredUser<User>());
    setLoading(false);
  }, []);

  const logout = () => {
    clearSession();
    setUser(null);
    window.location.href = "/login";
  };

  const isAdmin = user?.role === "ADMIN";
  const isOwnerOrAdmin = user?.role === "OWNER" || user?.role === "ADMIN";

  return (
    <AuthContext.Provider value={{ user, loading, isAdmin, isOwnerOrAdmin, setUser, logout }}>
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
