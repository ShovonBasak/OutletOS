import { api } from "./api";
import { today } from "./format";
import type { DailyClosing, Paginated } from "./types";

/** Get the closing for the outlet on `date` (defaults to today), creating a DRAFT if none exists. */
export async function getOrCreateTodayClosing(outlet: number, date?: string): Promise<DailyClosing> {
  const d = date ?? today();
  const existing = await api<Paginated<DailyClosing>>(
    `/daily-closings/?outlet=${outlet}&date=${d}`
  );
  if (existing.results[0]) return existing.results[0];
  return api<DailyClosing>("/daily-closings/", {
    method: "POST",
    body: JSON.stringify({ outlet, closing_date: d }),
  });
}
