"use client";

import { createContext, useContext } from "react";
import type { Outlet } from "./types";

// Which outlet an Owner's screens (Stock, Stock In, Expenses, Other income,
// Fryer oil, Sell corrections, Accounts, …) are currently scoped to. An
// Owner has no `user.outlet` of their own (that's a STAFF-only assignment) —
// for a single-outlet organization this resolves automatically with no
// prompt; for a multi-outlet organization the Owner picks one after login
// (see OwnerLayout) and can switch any time from the user menu.
export interface OwnerOutletCtx {
  outlets: Outlet[];
  selectedOutlet: Outlet | null;
  selectOutlet: (id: number) => void;
  loading: boolean;
}

export const OwnerOutletContext = createContext<OwnerOutletCtx>({
  outlets: [],
  selectedOutlet: null,
  selectOutlet: () => {},
  loading: true,
});

export const useOwnerOutlet = () => useContext(OwnerOutletContext);
