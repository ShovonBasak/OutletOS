import { api } from "./api";
import { today } from "./format";
import type { DailyClosing, Paginated } from "./types";

/** Get today's closing for the outlet, creating a DRAFT if none exists. */
export async function getOrCreateTodayClosing(outlet: number): Promise<DailyClosing> {
  const existing = await api<Paginated<DailyClosing>>(
    `/daily-closings/?outlet=${outlet}&date=${today()}`
  );
  if (existing.results[0]) return existing.results[0];
  return api<DailyClosing>("/daily-closings/", {
    method: "POST",
    body: JSON.stringify({ outlet, closing_date: today() }),
  });
}
