"use client";

import { useEffect, useRef, useState } from "react";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Dhaka's weekend — matches the Fri/Sat highlighting convention used
// elsewhere in the app (e.g. the Sell history demand chart).
function isWeekendDow(dow: number): boolean {
  return dow === 5 || dow === 6;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** In-house calendar dropdown — replaces the OS/browser native date picker so
 * it matches the app's own theme (ticket cards, brand colors, monospace
 * figures) instead of whatever the platform renders. */
export function DatePicker({
  value,
  onChange,
  max,
  min,
  children,
}: {
  /** Selected date, ISO yyyy-mm-dd. */
  value: string;
  onChange: (iso: string) => void;
  /** Inclusive bounds, ISO yyyy-mm-dd. */
  max?: string;
  min?: string;
  /** Trigger content — whatever should open the picker on click. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseIso(value));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setViewDate(parseIso(value));
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const maxDate = max ? parseIso(max) : null;
  const minDate = min ? parseIso(min) : null;
  const todayIso = toIso(new Date());

  function disabledDate(d: Date): boolean {
    if (maxDate && d > maxDate) return true;
    if (minDate && d < minDate) return true;
    return false;
  }

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        {children}
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-xl border border-dashed border-[#d8cdb0] bg-paper p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewDate(new Date(year, month - 1, 1))}
              aria-label="Previous month"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-[#d8cdb0] font-mono text-xs text-ink-soft active:bg-paper-dim"
            >
              ‹
            </button>
            <span className="font-display text-[13px] font-bold text-ink">
              {MONTH_NAMES[month]} {year}
            </span>
            <button
              type="button"
              onClick={() => setViewDate(new Date(year, month + 1, 1))}
              aria-label="Next month"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-[#d8cdb0] font-mono text-xs text-ink-soft active:bg-paper-dim"
            >
              ›
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7">
            {WEEKDAYS.map((w, i) => (
              <span
                key={i}
                className={`text-center font-mono text-[9px] uppercase tracking-wide ${
                  isWeekendDow(i) ? "text-gold-deep" : "text-ink-soft/60"
                }`}
              >
                {w}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-1">
            {cells.map((d, i) => {
              if (!d) return <span key={i} />;
              const iso = toIso(d);
              const selected = iso === value;
              const isToday = iso === todayIso;
              const disabled = disabledDate(d);
              const weekend = isWeekendDow(d.getDay());
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  className={[
                    "mx-auto flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] transition",
                    disabled
                      ? "cursor-not-allowed text-ink-soft/25"
                      : selected
                      ? "bg-action font-bold text-gold"
                      : isToday
                      ? "border border-chrome font-semibold text-chrome"
                      : weekend
                      ? "text-gold-deep hover:bg-paper-dim"
                      : "text-ink hover:bg-paper-dim",
                  ].join(" ")}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {value !== todayIso && (
            <button
              type="button"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
              className="mt-2 w-full rounded border border-dashed border-[#d8cdb0] py-1.5 font-mono text-[10px] uppercase tracking-wide text-chrome hover:bg-paper-dim"
            >
              Jump to today
            </button>
          )}
        </div>
      )}
    </div>
  );
}
