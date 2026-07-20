"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearSession, getStoredUser, getAccess } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true, logout: () => {} });

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

  return <AuthContext.Provider value={{ user, loading, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** Guard a page to a role; redirect to /login if unauthenticated. */
export function useRequireRole(role: "STAFF" | "OWNER") {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!getAccess() || !user) {
      router.replace("/login");
    } else if (user.role !== role) {
      router.replace(user.role === "OWNER" ? "/owner" : "/staff");
    }
  }, [user, loading, role, router]);
  return { user, loading };
}
