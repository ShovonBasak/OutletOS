export function bdt(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `৳ ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function bdt2(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `৳ ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Like bdt but shows up to 2 decimal places only when needed (e.g. 25 → ৳ 25, 25.5 → ৳ 25.5, 25.56 → ৳ 25.56) */
export function bdtD(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return `৳ ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function shortDate(iso: string): string {
  // Parse date-only strings as local noon to avoid UTC-midnight-to-local-day-shift.
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Returns a human-readable pack breakdown for a raw quantity, e.g. "1 pack + 4 sticks".
 * Returns null when less than one full pack — nothing useful to show.
 * Both qty and piecesPerPack may be decimal strings from the API.
 */
export function packBreakdown(
  qty: number | string | null | undefined,
  piecesPerPack: number | string | null | undefined,
  unit: string
): string | null {
  const q = Number(qty);
  const p = Number(piecesPerPack);
  if (!p || p <= 0 || !q || q < p) return null;
  const fullPacks = Math.floor(q / p);
  if (fullPacks === 0) return null;
  // round remainder to avoid floating-point noise (e.g. 17.000000001)
  const remainder = Math.round((q - fullPacks * p) * 1000) / 1000;
  const packLabel = `${fullPacks} pack${fullPacks !== 1 ? "s" : ""}`;
  return remainder > 0 ? `${packLabel} + ${remainder} ${unit}` : packLabel;
}
