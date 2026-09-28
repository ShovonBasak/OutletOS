// Admin desktop/mobile nav. ADMIN is the cross-organization platform-admin
// role — it has no organization/outlet of its own, so its whole world is
// the platform (which organizations exist) and the GLOBAL catalog/types
// shared by every franchise outlet (same menu, same recipes, same prices,
// same expense/income categories everywhere). It never sees tenant-specific
// screens (reports, stock, sales, approvals) — those are OWNER-only, under
// /owner/*.

export interface NavItem {
  href: string;
  label: string;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const ADMIN_NAV: NavGroup[] = [
  {
    group: "Platform",
    items: [
      { href: "/admin/organizations", label: "Organizations" },
      { href: "/admin/applications",  label: "Tenant applications" },
    ],
  },
  {
    group: "Catalog",
    items: [
      { href: "/admin/products",          label: "Products & recipes" },
      { href: "/admin/setup/extract",     label: "Extract ingredients" },
      { href: "/admin/setup/import-menu", label: "Import menu" },
      { href: "/admin/setup/map-recipes", label: "Map recipes" },
    ],
  },
  {
    group: "Types",
    items: [
      { href: "/admin/settings/cost-categories",   label: "Cost categories" },
      { href: "/admin/settings/income-categories", label: "Income categories" },
    ],
  },
];

// True when pathname is exactly href or is a sub-route under it.
function under(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

const FLAT = ADMIN_NAV.flatMap((g) => g.items).sort((a, b) => b.href.length - a.href.length);

// Titles for sub-pages that aren't in the sidebar (reached via buttons).
const SUBPAGE_TITLES: Array<[string, string]> = [
  ["/admin/products/edit-recipe", "Edit recipe"],
  ["/admin/products/add-combo",   "Add combo"],
  ["/admin/products/add",         "Add product"],
  ["/admin/products/edit",        "Edit product"],
];

export function titleFor(pathname: string): string {
  const sub = SUBPAGE_TITLES.find(([href]) => under(pathname, href));
  if (sub) return sub[1];
  const match = FLAT.find((n) => under(pathname, n.href));
  return match?.label ?? "Admin";
}

// Mobile bottom-tab entry points — one per group, landing on its first item.
export interface MobileTab extends NavItem {
  icon: string;
}
export const ADMIN_MOBILE_TABS: MobileTab[] = [
  { href: "/admin/organizations",            label: "Platform", icon: "⌂" },
  { href: "/admin/products",                 label: "Catalog",  icon: "🍗" },
  { href: "/admin/settings/cost-categories", label: "Types",    icon: "≡" },
];

const TAB_GROUPS: Array<{ tab: string; prefixes: string[] }> = [
  { tab: "/admin/organizations", prefixes: ["/admin/organizations", "/admin/applications"] },
  { tab: "/admin/products", prefixes: ["/admin/products", "/admin/setup"] },
  { tab: "/admin/settings/cost-categories", prefixes: ["/admin/settings"] },
];

export function mobileTabFor(pathname: string): string {
  for (const g of TAB_GROUPS) {
    if (g.prefixes.some((p) => under(pathname, p))) return g.tab;
  }
  return "/admin/organizations";
}

// Which group contains the active route.
export function activeGroupFor(pathname: string): string | null {
  for (const g of ADMIN_NAV) {
    if (g.items.some((n) => under(pathname, n.href))) return g.group;
  }
  return null;
}
