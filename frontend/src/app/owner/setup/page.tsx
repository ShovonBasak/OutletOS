"use client";

import Link from "next/link";

const STEPS = [
  {
    href: "/owner/setup/extract",
    n: 1,
    title: "Extract ingredients from slips",
    hint: "Clean names + base unit + pack yield, captured once",
  },
  {
    href: "/owner/setup/import-menu",
    n: 2,
    title: "Import menu",
    hint: "Bulk-add the sellable products",
  },
  {
    href: "/owner/setup/map-recipes",
    n: 3,
    title: "Map recipes",
    hint: "Assign which ingredients each product uses",
  },
];

export default function SetupHub() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Setup</h1>
        <p className="text-xs text-ink-soft">Ingredients &amp; recipes — do these in order once</p>
      </div>

      <div className="flex flex-col gap-2">
        {STEPS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="flex items-center gap-3 rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-paper-dim font-mono text-xs text-ink-soft">
              {s.n}
            </span>
            <span className="flex-1">
              <span className="block font-display text-sm font-bold">{s.title}</span>
              <span className="block font-mono text-[11px] text-ink-soft">{s.hint}</span>
            </span>
            <span className="font-mono text-ink-soft">›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
