import { api } from "./api";
import type { Paginated } from "./types";

interface RoleDefaultAccountRow {
  account: number;
}

/** Which account should be pre-selected for `role` on expense/income/transfer
 * screens — the owner-configured default (Settings → Account access), or
 * `fallback` if nothing's configured yet. Distinct from `is_primary_cash`,
 * which names the shop's till and never varies by role. */
export async function resolveDefaultAccountId(
  role: "OWNER" | "STAFF",
  fallback: number | null
): Promise<number | null> {
  try {
    const rows = await api<Paginated<RoleDefaultAccountRow>>(
      `/role-default-accounts/?role=${role}`
    );
    return rows.results[0]?.account ?? fallback;
  } catch {
    return fallback;
  }
}
