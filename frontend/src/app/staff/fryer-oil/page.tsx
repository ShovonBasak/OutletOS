"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { today } from "@/lib/format";
import { useOperatingDay } from "@/lib/staffDay";

export default function FryerOilChangePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;

  const [pan, setPan] = useState<1 | 2 | null>(null);
  const [date, setDate] = useState(workDate || today());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!pan) return;
    setSubmitting(true);
    try {
      await api("/fryer-oil-changes/", {
        method: "POST",
        body: JSON.stringify({ outlet, pan_number: pan, changed_at: date, notes }),
      });
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <div className="ticket flex flex-col items-center gap-3 py-6 text-center">
          <span className="font-mono text-3xl">✓</span>
          <p className="font-display text-lg font-bold text-leaf-deep">Oil change logged</p>
          <p className="font-mono text-[11px] text-ink-soft">
            Pan {pan} · {date}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={() => router.push("/staff")}>
          Back to home
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-xl font-bold">Log oil change</h1>
        <p className="text-xs text-ink-soft">Record when fryer oil was replaced</p>
      </div>

      {/* Pan selector */}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Which pan?</p>
        <div className="grid grid-cols-2 gap-3">
          {([1, 2] as const).map((n) => (
            <button
              key={n}
              onClick={() => setPan(n)}
              className={`rounded border-2 py-5 font-display text-xl font-bold transition-colors ${
                pan === n
                  ? "border-action bg-action/10 text-ink"
                  : "border-[#d8cdb0] text-ink-soft hover:border-action/50"
              }`}
            >
              Pan {n}
            </button>
          ))}
        </div>
      </div>

      {/* Date */}
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">Date</label>
        <input
          type="date"
          className="field-input"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {/* Notes */}
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10px] uppercase tracking-wide text-ink-soft">
          Notes <span className="normal-case opacity-50">(optional)</span>
        </label>
        <textarea
          className="field-input min-h-[72px] resize-none"
          placeholder="e.g. oil was very dark, changed after 3 days…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <button
        className="btn btn-primary"
        disabled={!pan || !date || submitting}
        onClick={submit}
      >
        {submitting ? "Saving…" : "Log oil change"}
      </button>

      <button className="btn btn-ghost" onClick={() => router.push("/staff")}>
        Cancel
      </button>
    </div>
  );
}
