"use client";

import { useEffect } from "react";

/** Shared mobile bottom-sheet shell — backdrop, sliding panel, drag handle,
 * safe-area padding. Extracted from UserMenu so other flows (e.g.
 * MoveMoneySheet) get the exact same feel without re-implementing it.
 * Always rendered (never unmounted) so the slide transition has something
 * to animate from/to — only `open` toggles the translate. */
export function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      )}

      <div
        className={`fixed bottom-0 left-0 z-50 w-full rounded-t-3xl bg-paper shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)", maxHeight: "92dvh", overflowY: "auto" }}
      >
        <div className="sticky top-0 flex justify-center bg-paper pt-3 pb-1 z-10">
          <div className="h-1 w-10 rounded-full bg-ink-soft/20" />
        </div>
        {children}
      </div>
    </>
  );
}
