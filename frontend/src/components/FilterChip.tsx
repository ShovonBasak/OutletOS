// Shared by Expenses, Other Income, and the Transaction log — an active
// filter rendered as a removable pill under the "⚙ Filters" trigger.
export default function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-chrome-soft bg-chrome-soft/10 px-2.5 py-1 font-mono text-[10.5px] text-chrome-soft">
      {label}
      <button onClick={onClear} className="leading-none opacity-70 hover:opacity-100" aria-label={`Remove ${label} filter`}>
        ✕
      </button>
    </span>
  );
}
