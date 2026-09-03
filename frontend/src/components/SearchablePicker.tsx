"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

export interface SearchablePickerOption {
  id: number;
  name: string;
}

interface Props {
  options: SearchablePickerOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}

export default function SearchablePicker({
  options,
  value,
  onChange,
  placeholder = "— select —",
  searchPlaceholder = "Search…",
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => String(o.id) === value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="field-input flex items-center justify-between text-left"
        onClick={() => setOpen(true)}
      >
        <span className={selected ? "text-ink" : "text-ink-soft"}>
          {selected ? selected.name : placeholder}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-soft">▾</span>
      </button>
      <PickerSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        options={options}
        selectedId={value}
        onSelect={(id) => { onChange(id); setOpen(false); }}
        searchPlaceholder={searchPlaceholder}
        triggerRef={triggerRef}
      />
    </>
  );
}

type Pos = { top: number; left: number; width: number; maxH: number };

function PickerSheet({
  isOpen,
  onClose,
  options,
  selectedId,
  onSelect,
  searchPlaceholder,
  triggerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  options: SearchablePickerOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  searchPlaceholder: string;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const GAP = 4;
        const MARGIN = 16;
        const maxViewH = window.innerHeight * 0.65;
        const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
        const spaceAbove = rect.top - MARGIN;
        if (spaceBelow >= 140 || spaceBelow >= spaceAbove) {
          setPos({ top: rect.bottom + GAP, left: rect.left, width: rect.width, maxH: Math.min(spaceBelow, maxViewH) });
        } else {
          const maxH = Math.min(spaceAbove, maxViewH);
          setPos({ top: rect.top - maxH - GAP, left: rect.left, width: rect.width, maxH });
        }
      }
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen, triggerRef]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, search]);

  if (!isOpen || !pos) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/20" />
      <div
        className="absolute flex flex-col overflow-hidden rounded-xl border border-[#d8cdb0] bg-paper shadow-xl"
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[#d8cdb0] px-3 py-2">
          <input
            ref={inputRef}
            className="field-input w-full"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No matches.</p>
          )}
          {filtered.map((o) => {
            const isSelected = String(o.id) === selectedId;
            return (
              <button
                key={o.id}
                type="button"
                className={`flex w-full items-center justify-between border-b border-dotted border-[#d8cdb0] px-4 py-3 text-left transition-colors active:bg-paper-dim ${
                  isSelected ? "bg-action/10" : ""
                }`}
                onClick={() => onSelect(String(o.id))}
              >
                <span className={`font-mono text-sm ${isSelected ? "font-semibold text-ink" : "text-ink"}`}>
                  {o.name}
                </span>
                {isSelected && (
                  <span className="font-mono text-[11px] text-chrome">✓</span>
                )}
              </button>
            );
          })}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
