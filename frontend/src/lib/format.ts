export function bdt(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `৳ ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function bdt2(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `৳ ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
