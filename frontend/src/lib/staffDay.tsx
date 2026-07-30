"use client";

import { createContext, useContext } from "react";
import type { OperatingDay } from "./types";

export interface DayCtx {
  day: OperatingDay | null;
  refreshDay: () => Promise<void>;
  workDate: string;
  setWorkDate: (date: string) => void;
}

export const OperatingDayContext = createContext<DayCtx>({
  day: null,
  refreshDay: async () => {},
  workDate: "",
  setWorkDate: () => {},
});

export const useOperatingDay = () => useContext(OperatingDayContext);
