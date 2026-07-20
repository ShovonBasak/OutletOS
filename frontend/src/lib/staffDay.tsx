"use client";

import { createContext, useContext } from "react";
import type { OperatingDay } from "./types";

export interface DayCtx {
  day: OperatingDay | null;
  refreshDay: () => Promise<void>;
}

export const OperatingDayContext = createContext<DayCtx>({
  day: null,
  refreshDay: async () => {},
});

export const useOperatingDay = () => useContext(OperatingDayContext);
