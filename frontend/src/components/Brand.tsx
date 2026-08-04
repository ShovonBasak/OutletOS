export function Brand({ name, suffix }: { name?: string | null; suffix?: string }) {
  return (
    <div className="flex items-center gap-2 font-display text-[15px] font-bold tracking-tight">
      <span className="inline-block h-4 w-4 flex-shrink-0 rounded-full bg-red" />
      <span>
        {name ? (
          name
        ) : (
          <>CP <span className="text-gold">FIVE STAR</span></>
        )}
        {suffix ? <span className="font-body font-normal text-paper/80"> — {suffix}</span> : null}
      </span>
    </div>
  );
}
