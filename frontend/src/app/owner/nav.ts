// Owner desktop nav — grouped exactly per updated-cp-five-star-full-sitemap.html sidebar.
export interface NavItem {
  href: string;
  label: string;
}
export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const OWNER_NAV: NavGroup[] = [
  {
    group: "Overview",
    items: [{ href: "/owner", label: "Dashboard" }],
  },
  {
    group: "Approvals",
    items: [
      { href: "/owner/stock-in", label: "Stock in" },
      { href: "/owner/closings", label: "Closings" },
    ],
  },
  {
    group: "Reports",
    items: [
      { href: "/owner/stock", label: "Stock levels" },
      { href: "/owner/sales", label: "Sales report" },
      { href: "/owner/sell-history", label: "Sell history" },
      { href: "/owner/stock-in-history", label: "Stock in history" },
      { href: "/owner/settlements", label: "Settlements" },
      { href: "/owner/pnl", label: "Profit & loss" },
      { href: "/owner/packaging", label: "Packaging report" },
    ],
  },
  {
    group: "Manage",
    items: [
      { href: "/owner/sell-corrections", label: "Sell corrections" },
      { href: "/owner/accounts", label: "Accounts" },
      { href: "/owner/expenses", label: "Expenses" },
      { href: "/owner/other-income", label: "Other income" },
      { href: "/owner/products", label: "Products & recipes" },
      { href: "/owner/team", label: "Team & outlets" },
    ],
  },
  {
    group: "Settings",
    items: [
      { href: "/owner/settings/outlet", label: "Outlet" },
      { href: "/owner/settings/channels", label: "Sales channels" },
      { href: "/owner/settings/pricing", label: "Pricing & promos" },
      { href: "/owner/settings/menu-mapping", label: "Menu mapping" },
      { href: "/owner/settings/cost-categories", label: "Cost categories" },
    ],
  },
  {
    group: "Setup",
    items: [
      { href: "/owner/setup/extract", label: "Extract ingredients" },
      { href: "/owner/setup/import-menu", label: "Import menu" },
      { href: "/owner/setup/map-recipes", label: "Map recipes" },
    ],
  },
];

// True when pathname is exactly href or is a sub-route under it (requires a
// "/" boundary so "/owner/stock-in" never matches "/owner/stock-in-history").
function under(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

// Flattened, longest-href-first so sub-routes resolve to their parent nav item.
const FLAT = OWNER_NAV.flatMap((g) => g.items).sort((a, b) => b.href.length - a.href.length);

// Titles for sub-pages that aren't in the sidebar (reached via buttons/hubs).
const SUBPAGE_TITLES: Array<[string, string]> = [
  ["/owner/approvals", "Approvals"],
  ["/owner/reports", "Reports"],
  ["/owner/more", "More"],
  ["/owner/profile", "Profile"],
  ["/owner/products/edit-recipe", "Edit recipe"],
  ["/owner/products/add-combo", "Add combo"],
  ["/owner/products/add", "Add product"],
  ["/owner/team/add-outlet", "Add outlet"],
  ["/owner/settings/outlet", "Outlet"],
  ["/owner/settings/channels", "Sales channels"],
  ["/owner/settings/pricing", "Pricing & promos"],
  ["/owner/settings/menu-mapping", "Menu mapping"],
  ["/owner/settings/cost-categories", "Cost categories"],
];

export function titleFor(pathname: string): string {
  const sub = SUBPAGE_TITLES.find(([href]) => under(pathname, href));
  if (sub) return sub[1];
  const match = FLAT.find((n) => (n.href === "/owner" ? pathname === "/owner" : under(pathname, n.href)));
  return match?.label ?? "Dashboard";
}

// Mobile bottom-tab entry points — each opens a hub screen (per the sitemap's
// Home / Approvals / Reports / More tabs), from which every section is reachable.
export const OWNER_MOBILE_TABS: NavItem[] = [
  { href: "/owner", label: "Home" },
  { href: "/owner/approvals", label: "Approvals" },
  { href: "/owner/reports", label: "Reports" },
  { href: "/owner/more", label: "More" },
];

// Map any owner route to the bottom tab that should stay highlighted on mobile,
// so drilling into a section from a hub keeps its tab active.
const TAB_GROUPS: Array<{ tab: string; prefixes: string[] }> = [
  { tab: "/owner/approvals", prefixes: ["/owner/approvals", "/owner/stock-in", "/owner/closings"] },
  {
    tab: "/owner/reports",
    prefixes: ["/owner/reports", "/owner/stock", "/owner/sales", "/owner/sell-history", "/owner/stock-in-history", "/owner/settlements", "/owner/pnl", "/owner/packaging"],
  },
  {
    tab: "/owner/more",
    prefixes: ["/owner/more", "/owner/profile", "/owner/sell-corrections", "/owner/accounts", "/owner/expenses", "/owner/other-income", "/owner/products", "/owner/team", "/owner/settings", "/owner/setup"],
    // /owner/settings covers all sub-routes (outlet, channels, pricing, menu-mapping, cost-categories)
  },
];

export function mobileTabFor(pathname: string): string {
  for (const g of TAB_GROUPS) {
    if (g.prefixes.some((p) => under(pathname, p))) return g.tab;
  }
  return "/owner";
}

// Which accordion group (if any) contains the active route — used to auto-open it.
export function activeGroupFor(pathname: string): string | null {
  for (const g of OWNER_NAV) {
    if (g.items.some((n) => (n.href === "/owner" ? false : under(pathname, n.href)))) {
      return g.group;
    }
  }
  return null;
}
