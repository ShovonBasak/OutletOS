"use client";

import { useEffect, useState } from "react";

/** Transient success toast — extracted from UserMenu so other flows
 * (e.g. MoveMoneySheet) can show the same confirmation feedback. */
export function Snackbar({ text, onDone }: { text: string; onDone: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Animate in next tick so the transition fires
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => setVisible(false), 3000);
    const done = setTimeout(onDone, 3400);
    return () => { clearTimeout(show); clearTimeout(hide); clearTimeout(done); };
  }, [onDone]);

  return (
    <div
      className={`fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-2xl bg-[#1a1008] px-5 py-3.5 shadow-xl transition-all duration-400 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      }`}
      style={{ maxWidth: "calc(100vw - 2rem)" }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-leaf text-[10px] text-white">
        ✓
      </span>
      <p className="font-mono text-[12px] font-medium text-white/90 whitespace-nowrap">{text}</p>
    </div>
  );
}
