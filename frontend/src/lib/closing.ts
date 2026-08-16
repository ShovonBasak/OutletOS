import { api } from "./api";
import { today } from "./format";
import type { DailyClosing, Paginated } from "./types";

interface CacheEntry {
  closing: DailyClosing;
  fetchedAt: number;
}

const TTL = 30_000; // 30 seconds
const cache = new Map<string, CacheEntry>();

function cacheKey(outlet: number, date: string): string {
  return `${outlet}:${date}`;
}

export function invalidateClosingCache(outlet: number, date: string): void {
  cache.delete(cacheKey(outlet, date));
}

/** Get the closing for the outlet on `date` (defaults to today), creating a DRAFT if none exists.
 *  Results are cached for 30s to avoid redundant API calls between closing sub-pages. */
export async function getOrCreateTodayClosing(outlet: number, date?: string): Promise<DailyClosing> {
  const d = date ?? today();
  const key = cacheKey(outlet, d);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL) {
    return hit.closing;
  }

  const existing = await api<Paginated<DailyClosing>>(
    `/daily-closings/?outlet=${outlet}&date=${d}&expand=full`
  );
  const closing = existing.results[0] ?? await api<DailyClosing>("/daily-closings/", {
    method: "POST",
    body: JSON.stringify({ outlet, closing_date: d }),
  });

  cache.set(key, { closing, fetchedAt: Date.now() });
  return closing;
}
