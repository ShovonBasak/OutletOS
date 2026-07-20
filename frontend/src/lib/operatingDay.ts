import { api } from "./api";
import type {
  CarryForwardRow,
  DayStartStockRow,
  OperatingDay,
} from "./types";

/** Get (or lazily create) today's OperatingDay for the outlet. */
export async function getTodayOperatingDay(outlet: number): Promise<OperatingDay> {
  return api<OperatingDay>(`/operating-days/today/?outlet=${outlet}`, {
    method: "POST",
  });
}

export async function fetchDayStartStock(dayId: number): Promise<DayStartStockRow[]> {
  return api<DayStartStockRow[]>(`/operating-days/${dayId}/day-start-stock/`);
}

export async function confirmDayStartStock(
  dayId: number,
  items: DayStartStockRow[]
): Promise<OperatingDay> {
  return api<OperatingDay>(`/operating-days/${dayId}/confirm-stock/`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

export async function fetchCarryForward(dayId: number): Promise<CarryForwardRow[]> {
  return api<CarryForwardRow[]>(`/operating-days/${dayId}/carry-forward/`);
}

export async function confirmCarryForward(
  dayId: number,
  items: CarryForwardRow[]
): Promise<OperatingDay> {
  return api<OperatingDay>(`/operating-days/${dayId}/confirm-carry-forward/`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

/** Human-readable next-step hint for the gated flow. */
export function nextStepFor(day: OperatingDay): { label: string; href: string } | null {
  if (day.status === "NOT_STARTED") {
    return { label: "Confirm day-start stock", href: "/staff/day-start" };
  }
  if (day.status === "STOCK_CONFIRMED") {
    return { label: "Move yesterday's leftovers", href: "/staff/prep/carry-forward" };
  }
  return null;
}
