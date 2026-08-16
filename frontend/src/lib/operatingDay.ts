import { api } from "./api";
import type {
  CarryForwardRow,
  DayStartStockRow,
  OperatingDay,
} from "./types";

interface DayCacheEntry {
  day: OperatingDay;
  fetchedAt: number;
}

const TTL = 30_000; // 30 seconds
const dayCache = new Map<string, DayCacheEntry>();

function dayCacheKey(outlet: number, date: string): string {
  return `${outlet}:${date}`;
}

export function invalidateDayCache(outlet: number, date: string): void {
  dayCache.delete(dayCacheKey(outlet, date));
}

/** Get (or lazily create) an OperatingDay for the given date (defaults to today).
 *  Pass slim=true (default) for layout nav calls — omits stock_checks array.
 *  Pass slim=false for the day-start screen which needs stock_checks.
 *  Results are cached for 30s so tab switches don't re-fetch. */
export async function getTodayOperatingDay(outlet: number, date?: string, slim = true): Promise<OperatingDay> {
  const params = new URLSearchParams({ outlet: String(outlet) });
  if (date) params.set("date", date);
  if (slim) params.set("slim", "1");

  const key = dayCacheKey(outlet, date ?? "today");
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL) {
    return hit.day;
  }

  const day = await api<OperatingDay>(`/operating-days/today/?${params}`, { method: "POST" });
  dayCache.set(key, { day, fetchedAt: Date.now() });
  return day;
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
