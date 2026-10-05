import { today } from "./format";

// Shared by Expenses and Other Income — both filter a date-stamped list by
// the same four periods, with "Month" letting the owner pick any specific
// month/year rather than being locked to the current one.
export type Period = "today" | "week" | "month" | "custom";

export function lastDayOfMonth(monthValue: string): string {
  const [y, m] = monthValue.split("-").map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10); // day 0 of next month = last day of this one
}

export function monthLabel(monthValue: string): string {
  const [y, m] = monthValue.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function rangeFor(
  period: Period,
  monthValue: string,
  custom: { from: string; to: string }
): { from: string; to: string } {
  const end = today();
  if (period === "today") return { from: end, to: end };
  if (period === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: end };
  }
  if (period === "month") {
    const from = `${monthValue}-01`;
    const to = monthValue === end.slice(0, 7) ? end : lastDayOfMonth(monthValue);
    return { from, to };
  }
  return custom;
}
