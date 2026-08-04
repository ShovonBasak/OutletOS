"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Ingredient } from "@/lib/types";

const GROUP_ORDER = [
  "CHICKEN_PIECE", "SNACK", "BURGER_WRAP", "BEVERAGE", "SUPPLY", "OTHER",
] as const;

const GROUP_LABELS: Record<string, string> = {
  CHICKEN_PIECE: "Chicken",
  SNACK: "Snacks",
  BURGER_WRAP: "Burger & Wrap",
  BEVERAGE: "Beverages",
  SUPPLY: "Supplies",
  OTHER: "Other",
};

// ── Trigger + sheet wired together ───────────────────────────────────────────

interface IngredientPickerProps {
  ingredients: Ingredient[];
  value: number | null;
  onChange: (id: number) => void;
  placeholder?: string;
  className?: string;
}

export default function IngredientPicker({
  ingredients,
  value,
  onChange,
  placeholder = "Choose ingredient…",
  className = "",
}: IngredientPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = value != null ? ingredients.find((i) => i.id === value) : null;
  const selectedLabel = selected
    ? (selected.aliases?.find((a) => a.is_active)?.alias_text ?? selected.name)
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`field-input flex items-center justify-between text-left ${className}`}
        onClick={() => setOpen(true)}
      >
        <span className={selected ? "text-ink" : "text-ink-soft"}>
          {selectedLabel ?? placeholder}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-soft">▾</span>
      </button>
      <IngredientPickerSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        ingredients={ingredients}
        selectedId={value}
        onSelect={(id) => { onChange(id); setOpen(false); }}
        triggerRef={triggerRef}
      />
    </>
  );
}

// ── Floating sheet ────────────────────────────────────────────────────────────

type PickerPos = { top: number; left: number; width: number; maxH: number };

function IngredientPickerSheet({
  isOpen,
  onClose,
  ingredients,
  selectedId,
  onSelect,
  triggerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  ingredients: Ingredient[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<PickerPos | null>(null);

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
    if (!q) return ingredients;
    return ingredients.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.aliases?.some((a) => a.is_active && a.alias_text.toLowerCase().includes(q))
    );
  }, [ingredients, search]);

  const groups = useMemo(() => {
    const map = new Map<string, Ingredient[]>();
    filtered.forEach((ing) => {
      const g = ing.group ?? "OTHER";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(ing);
    });
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g as typeof GROUP_ORDER[number]);
      return i === -1 ? 999 : i;
    };
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b));
  }, [filtered]);

  const showGroups = groups.length > 1;

  if (!isOpen || !pos) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/20" />
      <div
        className="absolute flex flex-col overflow-hidden rounded-xl border border-[#d8cdb0] bg-paper shadow-xl"
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* search */}
        <div className="border-b border-[#d8cdb0] px-3 py-2">
          <input
            ref={inputRef}
            className="field-input w-full"
            placeholder="Search ingredients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* list */}
        <div className="overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center font-mono text-xs text-ink-soft">No matches.</p>
          )}
          {groups.map(([group, items]) => (
            <div key={group}>
              {showGroups && (
                <p className="sticky top-0 bg-paper px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft">
                  {GROUP_LABELS[group] ?? group}
                </p>
              )}
              {items.map((ing) => {
                const isSelected = ing.id === selectedId;
                const primaryAlias = ing.aliases?.find((a) => a.is_active)?.alias_text ?? null;
                return (
                  <button
                    key={ing.id}
                    type="button"
                    className={`flex w-full items-start justify-between border-b border-dotted border-[#d8cdb0] px-4 py-3 text-left transition-colors active:bg-paper-dim ${
                      isSelected ? "bg-action/10" : ""
                    }`}
                    onClick={() => onSelect(ing.id)}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className={`font-mono text-sm ${isSelected ? "font-semibold text-ink" : "text-ink"}`}>
                        {primaryAlias ?? ing.name}
                      </span>
                      {primaryAlias && (
                        <span className="font-mono text-[10px] text-ink-soft truncate">
                          {ing.name}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5 pl-2">
                      <span className="font-mono text-[10px] text-ink-soft">{ing.base_unit}</span>
                      {isSelected && (
                        <span className="font-mono text-[11px] text-chrome">✓</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}
