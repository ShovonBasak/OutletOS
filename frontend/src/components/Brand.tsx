export function Brand({ suffix }: { suffix?: string }) {
  return (
    <div className="flex items-center gap-2 font-display text-[15px] font-bold tracking-tight">
      <span className="inline-block h-4 w-4 flex-shrink-0 rounded-full bg-red" />
      <span>
        CP <span className="text-gold">FIVE STAR</span>
        {suffix ? <span className="font-body font-normal text-paper/80"> — {suffix}</span> : null}
      </span>
    </div>
  );
}
