import { bdt } from "@/lib/format";

// Shared by Expenses and Other Income — a ranked list with a proportion bar
// per row, used for "By account"/"By type"/"By category" summaries. Reads
// at a glance even with many rows, unlike chips that wrap once they run out
// of horizontal room.
export default function BreakdownList({
  title, rows, total,
}: {
  title: string;
  rows: { name: string; amount: number }[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[#d8cdb0] bg-[#fffdf7] p-3">
      <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{title}</h3>
      <div className="flex flex-col gap-2">
        {sorted.map((r) => {
          const pct = total > 0 ? (r.amount / total) * 100 : 0;
          return (
            <div key={r.name} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[12px] text-ink">{r.name}</span>
                <span className="shrink-0 font-mono text-[12px] font-semibold text-ink">{bdt(r.amount)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-dim">
                <div className="h-full rounded-full bg-chrome-soft" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
