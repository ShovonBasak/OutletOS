export type Role = "STAFF" | "OWNER" | "ADMIN";

export interface User {
  id: number;
  name: string;
  role: Role;
  outlet: number | null;
  outlet_name: string | null;
  phone: string;
  is_active: boolean;
}

export interface Outlet {
  id: number;
  name: string;
  address: string;
  is_active: boolean;
  allow_staff_date_selection: boolean;
}

export type ProductType = "SINGLE" | "COMBO";
export type TrackingMode = "RECIPE_LINKED" | "PERIODIC_COUNT" | "ONE_TIME";

export interface PackDefinition {
  id: number;
  ingredient: number;
  base_unit?: string;
  pieces_per_pack: string;
  cost_per_pack: string;
  cost_per_base_unit?: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface SupplierProductAlias {
  id: number;
  ingredient: number;
  ingredient_name?: string;
  alias_text: string;
  is_active: boolean;
}

export interface Ingredient {
  id: number;
  name: string;
  base_unit: string;
  tracking_mode: TrackingMode;
  group: IngredientGroup;
  is_active: boolean;
  active_pack: PackDefinition | null;
  aliases: SupplierProductAlias[];
}

/** Slim ingredient shape returned by GET /ingredients/?slim=1.
 *  Used on pages that only need picker data and not aliases or pack cost details. */
export interface IngredientSummary {
  id: number;
  name: string;
  base_unit: string;
  group: IngredientGroup;
  active_pack: { id: number; pieces_per_pack: string } | null;
}

export interface ExtractCandidate {
  raw_text: string;
  suggested_name: string;
  suggested_unit: string;
  suggested_qty_per_pack: number | null;
  cost_per_pack: number | null;
  is_probably_not_ingredient: boolean;
  seen_in_slips: number;
}

export interface ExtractResult {
  slips_processed: number;
  new_count: number;
  skipped_existing: number;
  candidates: ExtractCandidate[];
}

export interface Recipe {
  id: number;
  product: number;
  ingredient: number;
  ingredient_name: string;
  base_unit: string;
  quantity_per_unit: string;
  is_primary: boolean;
}

export interface RecipeProductComponent {
  id: number;
  product: number;
  component_product: number;
  component_name: string;
  quantity_per_unit: string;
}

export interface ComboComponent {
  id: number;
  combo_product: number;
  component_product: number;
  component_name: string;
  quantity_per_combo: number;
}

export interface ProductPrice {
  id: number;
  product: number;
  price: string;
  effective_from: string;
  effective_to: string | null;
  changed_by: number | null;
  changed_by_name: string | null;
  note: string;
  is_active: boolean;
}

export const PRODUCT_CATEGORIES = [
  "Fried Chicken",
  "Snacks",
  "Light Snacks",
  "Meals",
  "Rice & Sides",
  "Beverages",
  "Add-on",
  "Combo",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface Product {
  id: number;
  name: string;
  category: ProductCategory | string;
  product_type: ProductType;
  requires_preparation: boolean;
  /** Computed from the active ProductPrice — read-only in GET responses. */
  selling_price: string;
  /** Full active ProductPrice object, null if no price set yet. Absent on slim list responses. */
  active_price?: ProductPrice | null;
  is_active: boolean;
  components: ComboComponent[];
  recipes: Recipe[];
  product_recipe_components: RecipeProductComponent[];
}

/** Slim product shape returned by /products/?prep=1 — excludes combo components and active_price. */
export interface PrepProduct {
  id: number;
  name: string;
  category: ProductCategory | string;
  requires_preparation: boolean;
  selling_price: string;
  recipes: Recipe[];
  product_recipe_components: RecipeProductComponent[];
}

export type SettlementType = "DIRECT_TO_ACCOUNT" | "COLLECTED_AT_OUTLET";

export interface SalesChannel {
  id: number;
  name: string;
  commission_rate: string;
  settlement_type: SettlementType;
  integration_type: "API_SYNC" | "MANUAL";
  commission_basis: string;
  is_active: boolean;
}

// ---- Operating day (gated staff flow) -------------------------------------
export type OperatingDayStatus =
  | "NOT_STARTED"
  | "STOCK_CONFIRMED"
  | "IN_PROGRESS"
  | "CLOSED";

export type DiscrepancyReason =
  | ""
  | "SPOILED"
  | "MISCOUNTED_YESTERDAY"
  | "SURPLUS_FOUND"
  | "OTHER";

export interface DayStartStockCheck {
  id: number;
  operating_day: number;
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  ingredient_group: string;
  base_unit: string;
  system_carried_qty: string;
  confirmed_qty: string;
  discrepancy_qty: string;
  discrepancy_reason: DiscrepancyReason;
  note: string;
}

export interface OperatingDay {
  id: number;
  outlet: number;
  date: string;
  status: OperatingDayStatus;
  started_by: number | null;
  started_at: string | null;
  stock_confirmed_at: string | null;
  carry_forward_confirmed_at: string | null;
  daily_closing: number | null;
  stock_in_unlocked: boolean;
  full_unlocked: boolean;
  /** Absent when fetched with ?slim=1 (layout nav calls). Present on full OperatingDay. */
  stock_checks?: DayStartStockCheck[];
}

// A day-start-stock row (the reconcile list, before it becomes a check).
export interface DayStartStockRow {
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  ingredient_group: IngredientGroup;
  primary_product: string;
  base_unit: string;
  pieces_per_pack: string | null;
  system_carried_qty: number;
  confirmed_qty: number;
  discrepancy_reason: DiscrepancyReason;
  note: string;
}

export interface CarryForwardRow {
  stock_count: number;
  product: number;
  product_name: string;
  leftover_available_pieces: number;
  pieces_prepared: number;
}

// ---- Stock in --------------------------------------------------------------
export type StockInStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";
export type UnitCaptured = "PACK" | "PIECE";

export interface StockInItem {
  id?: number;
  ingredient: number | null;
  ingredient_name?: string;
  base_unit?: string;
  raw_extracted_text?: string;
  source: "SLIP_EXTRACTED" | "MANUAL";
  unit_captured: UnitCaptured;
  extracted_quantity?: string | null;
  confirmed_quantity: string;
  pack_definition: number | null;
  pieces_per_pack?: string | null;
  base_unit_quantity?: string;
  is_unrecognized?: boolean;
  needs_pack_yield?: boolean;
  // Price fields from supplier slip
  rate?: string | null;
  total_amount?: string | null;
  sd_rate?: string | null;
  sd_amount?: string | null;
  vat_rate?: string | null;
  vat_amount?: string | null;
  line_total?: string | null;
  unit_price?: string | null;
}

export interface StockInRecord {
  id: number;
  outlet: number;
  stock_in_date: string;
  invoice_number: string;
  submitted_by: number;
  submitted_by_name: string;
  status: StockInStatus;
  reviewed_by: number | null;
  reviewed_at: string | null;
  slip_image: string | null;
  notes: string;
  slip_vat_total?: string | null;
  slip_grand_total?: string | null;
  paid_from_account: number | null;
  paid_from_account_name: string | null;
  created_at: string;
  /** Present on detail/full responses; absent on slim list responses. */
  items?: StockInItem[];
  /** Present only on slim list responses. */
  item_count?: number;
  /** Present only on slim list responses: "Slip", "Manual", or "Slip + manual". */
  source_summary?: string;
  /** Present only on full detail responses. */
  unresolved_count?: number;
}

// ---- Preparation -----------------------------------------------------------
export type PrepSource = "FRESH" | "CARRIED_FORWARD";

export interface PreparationLog {
  id: number;
  outlet: number;
  logged_by: number;
  product: number;
  product_name: string;
  timestamp: string;
  source: PrepSource;
  carried_forward_from: number | null;
  leftover_available_pieces: number | null;
  prep_unit: "PACK" | "PIECE";
  packs_used: string | null;
  pieces_prepared: number;
  wastage_pieces: number | null;
}

/** Slim prep log returned by /preparation-logs/?slim=1. */
export interface PrepLog {
  id: number;
  product: number;
  product_name: string;
  source: PrepSource;
  timestamp: string;
  prep_unit: "PACK" | "PIECE";
  packs_used: string | null;
  pieces_prepared: number;
}

export type IngredientGroup = string; // now a product category string e.g. "Fried Chicken"

// Canonical order for grouping ingredients by the product category they belong to.
export const INGREDIENT_GROUPS: { key: string; icon: string }[] = [
  { key: "Fried Chicken", icon: "🍗" },
  { key: "Snacks",        icon: "🍡" },
  { key: "Light Snacks",  icon: "🍢" },
  { key: "Meals",         icon: "🍔" },
  { key: "Rice & Sides",  icon: "🍚" },
  { key: "Beverages",     icon: "🥤" },
  { key: "Add-on",        icon: "➕" },
  { key: "Combo",         icon: "📦" },
  { key: "Other",         icon: "🗂"  },
];

export interface RawStock {
  id: number;
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  ingredient_group: IngredientGroup;
  primary_product: string;
  base_unit: string;
  tracking_mode: TrackingMode;
  quantity_available: string;
  pieces_per_pack: string | null;
  cost_per_base_unit: string | null;
}

/** Slim raw stock returned by /raw-stock/?slim=1. */
export interface RawStockSlim {
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  base_unit: string;
  quantity_available: string;
  pieces_per_pack: string | null;
}

export interface DisplayStock {
  id: number;
  product: number;
  product_name: string;
  product_category: string;
  pieces_available: number;
}

/** Slim display stock returned by /display-stock/?slim=1. */
export interface DisplayStockSlim {
  product: number;
  pieces_available: number;
}

// ---- Packaging (periodic count) -------------------------------------------
export interface PackagingLevel {
  ingredient: number;
  ingredient_name: string;
  ingredient_group: string;
  base_unit: string;
  pieces_per_pack: string | null;
  current_qty: string;
  source: "counted" | "counted_plus_stock_in" | "stock_in_derived";
  last_checked_at: string | null;
}

export interface PeriodicStockCheck {
  id: number;
  outlet: number;
  ingredient: number;
  ingredient_name: string;
  base_unit: string;
  checked_at: string;
  checked_by: number;
  checked_by_name: string;
  counted_qty: string;
  stock_in_since_last_check: string;
  consumed_since_last_check: string;
  note: string;
}

export interface PackagingReportRow {
  ingredient: string;
  base_unit: string;
  consumed: string;
  cost: string;
  consumption_ratio: string;
}

export interface PackagingReport {
  start: string;
  end: string;
  total_units_sold: number;
  rows: PackagingReportRow[];
}

// ---- Closing ---------------------------------------------------------------
export type ClosingStatus = "DRAFT" | "SUBMITTED" | "LOCKED";

export interface StockCount {
  id: number;
  product: number;
  product_name: string;
  product_category: string;
  requires_preparation: boolean;
  available_pieces: number;
  wastage_pieces: number;
  remains_pieces: number;
  app_channel_sold: number;
  derived_walkin_sold: number;
  flag: boolean;
  wastage_cost: string;
  unit_price: string;
  remains_value: string;
  pieces_per_pack: string | null;
}

export interface SalesLine {
  id: number;
  product: number;
  product_name: string;
  channel: number;
  channel_name: string;
  quantity_sold: number;
  unit_price: string;
  gross_amount: string;
  net_amount: string;
  source: "STAFF_ENTRY" | "SYSTEM_DERIVED";
}

export interface PaymentEntry {
  id: number;
  account: number;
  account_name: string;
  is_primary_cash: boolean;
  amount: string;
}

export interface DailyClosing {
  id: number;
  outlet: number;
  closing_date: string;
  staff: number;
  staff_name: string;
  status: ClosingStatus;
  stock_counts: StockCount[];
  sales_lines: SalesLine[];
  channel_discounts: { id: number; channel: number; channel_name: string; discount_amount: string }[];
  payments: PaymentEntry[];
  total_sale: string;
  channel_day_net_revenue: string;
  online_payments: string;
  total_offline_sales: string;
  computed_cash: string;
  has_flag: boolean;
  carried_forward_value: string;
}

export interface ProductPerformanceRow {
  product_id: number;
  product_name: string;
  category: string;
  units_sold: number;
  gross_revenue: string;
  net_revenue: string;
  cogs: string;
  gross_profit: string;
  margin_pct: string;
}

export interface ChannelBreakdownRow {
  channel_id: number;
  channel_name: string;
  units_sold: number;
  gross_revenue: string;
  commission: string;
  platform_discount: string;
  net_revenue: string;
}

export interface StockValueRow {
  ingredient_id: number;
  ingredient_name: string;
  display_name: string;
  group: IngredientGroup;
  quantity: string;
  base_unit: string;
  cost_per_unit: string;
  value: string;
}

export interface StockValueReport {
  total_value: string;
  rows: StockValueRow[];
}

export interface DailyTrendRow {
  date: string;
  units_sold: number;
  revenue: string;
}

export interface Pnl {
  start: string;
  end: string;
  revenue: string;
  cogs: string;
  gross_profit: string;
  wastage_cost: string;
  shrinkage_cost: string;
  packaging_cost: string;
  fixed_costs: string;
  variable_costs: string;
  adhoc_costs: string;
  other_income: string;
  net_profit: string;
}

export interface DashboardSummary {
  date: string;
  pnl_today: Pnl;
  pending_stock_ins: number;
  closings_awaiting_review: number;
}

export interface DashboardDailyRow {
  date: string;
  units_sold: number;
  revenue: string;
  cogs: string;
}

export interface DashboardProductRow {
  product_name: string;
  category: string;
  units_sold: number;
  revenue: string;
  cogs: string;
  gross_profit: string;
  margin_pct: string;
}

export interface DashboardChannelRow {
  channel: string;
  units_sold: number;
  revenue: string;
  commission: string;
}

export interface DashboardData {
  start: string;
  end: string;
  pnl: Pnl;
  daily: DashboardDailyRow[];
  top_products: DashboardProductRow[];
  channels: DashboardChannelRow[];
}


export interface ChannelMenuMap {
  id: number;
  channel: number;
  channel_name: string;
  external_name: string;
  product: number;
  product_name: string;
  quantity_multiplier: number;
  is_active: boolean;
}

export interface ChannelPromotion {
  id: number;
  channel: number | null;
  product: number | null;
  discount_type: "PERCENTAGE" | "FIXED_AMOUNT";
  value: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface OrderLevelOffer {
  id: number;
  channel: number | null;
  description: string;
  threshold_amount: string;
  discount_type: "PERCENTAGE" | "FIXED_AMOUNT";
  value: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface CostCategory {
  id: number;
  name: string;
  cost_type: "FIXED" | "VARIABLE" | "ADHOC";
}

export type ExpenseSource = "CASH" | "BKASH";

export interface Expense {
  id: number;
  outlet: number;
  date: string;
  category: number;
  category_name: string;
  cost_type: string;
  amount: string;
  source: ExpenseSource;
  paid_from_account: number | null;
  paid_from_account_name: string | null;
  description: string;
  recurring: boolean;
}

// ---- Financial Accounts ----------------------------------------------------

export type AccountType = "BANK" | "MOBILE_WALLET" | "CASH" | "SUPPLIER_CREDIT";

export interface FinancialAccount {
  id: number;
  outlet: number | null;
  account_type: AccountType;
  account_type_display: string;
  name: string;
  provider: string;
  opening_balance: string;
  opening_balance_date: string;
  is_active: boolean;
  is_primary_cash: boolean;
  current_balance: string;
}

export interface FinancialAccountName {
  id: number;
  account_type: AccountType;
  name: string;
  is_active: boolean;
  is_primary_cash: boolean;
}

export type TransactionType =
  | "SALES_COLLECTION"
  | "EXPENSE_PAYMENT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "CAPITAL_INJECTION"
  | "OWNER_WITHDRAWAL"
  | "ADJUSTMENT"
  | "SUPPLIER_ORDER_DEDUCTION"
  | "OTHER_INCOME";

export interface AccountTransaction {
  id: number;
  account: number;
  account_name: string;
  transaction_type: TransactionType;
  transaction_type_display: string;
  amount: string;
  date: string;
  source_type: string;
  source_id: number | null;
  entered_by: number;
  entered_by_name: string;
  note: string;
}

export interface AccountTransfer {
  id: number;
  from_account: number;
  from_account_name: string;
  to_account: number;
  to_account_name: string;
  amount: string;
  date: string;
  note: string;
  entered_by: number;
  entered_by_name: string;
}

export interface CapitalTransaction {
  id: number;
  account: number;
  account_name: string;
  direction: "INJECTION" | "WITHDRAWAL";
  direction_display: string;
  amount: string;
  date: string;
  note: string;
  entered_by: number;
  entered_by_name: string;
}

export interface AccountBalanceCheck {
  id: number;
  account: number;
  account_name: string;
  checked_at: string;
  checked_by: number;
  checked_by_name: string;
  system_balance: string;
  actual_balance: string;
  discrepancy: string;
  reason: string;
  reason_display: string;
  note: string;
}

export interface OtherIncomeCategory {
  id: number;
  name: string;
}

export interface OtherIncome {
  id: number;
  outlet: number;
  date: string;
  category: number;
  category_name: string;
  amount: string;
  received_into_account: number | null;
  received_into_account_name: string | null;
  description: string;
}

export interface PurchaseSummaryRecord {
  id: number;
  date: string;
  invoice_number: string;
  amount: string;
  source: "slip_total" | "line_totals" | "computed";
}

export interface PurchaseSummary {
  start: string;
  end: string;
  total: string;
  record_count: number;
  records: PurchaseSummaryRecord[];
  daily: { date: string; amount: string }[];
}

export interface ShrinkageRow {
  date: string;
  ingredient: string;
  base_unit: string;
  system_qty: string;
  confirmed_qty: string;
  shortfall_qty: string;
  cost_per_unit: string;
  cost: string;
  reason: string;
  note: string;
}

export interface ShrinkageDetail {
  start: string;
  end: string;
  total: string;
  rows: ShrinkageRow[];
}

// ---- Owner day overview ---------------------------------------------------

export interface DayOverviewStockCheck {
  ingredient: string;
  base_unit: string;
  system_qty: string;
  confirmed_qty: string;
  discrepancy_qty: string;
  discrepancy_reason: string;
  note: string;
  shrinkage_cost: string;
  pieces_per_pack: string | null;
  ingredient_group: IngredientGroup;
}

export interface DayOverviewStockIn {
  id: number;
  status: StockInStatus;
  item_count: number;
  submitted_by_name: string;
  notes: string;
  invoice_number: string;
}

export interface DayOverviewPrepLog {
  id: number;
  product_name: string;
  product_category: string;
  source: PrepSource;
  prep_unit: "PACK" | "PIECE";
  packs_used: string | null;
  pieces_prepared: number;
  wastage_pieces: number | null;
  timestamp: string;
  selling_price: string;
}

export interface DayOverviewDisplayStock {
  product_name: string;
  product_category: string;
  pieces_available: number;
  requires_preparation: boolean;
  selling_price: string;
  purchase_price: string | null;
  pieces_per_pack: string | null;
}

export interface DayOverviewRawStock {
  ingredient: string;
  base_unit: string;
  quantity_available: string;
  cost_per_base_unit: string;
  ingredient_group: IngredientGroup;
  primary_product: string;
  pieces_per_pack: string | null;
}

export interface DayOverviewSalesProduct {
  product_name: string;
  product_category: string;
  walkin_sold: number;
  online_sold: number;
  total_sold: number;
  selling_price: string;
  revenue: string;
}

export interface DayOverviewClosing {
  id: number;
  status: ClosingStatus;
  total_sale: string;
  channel_day_net_revenue: string;
  online_payments: string;
  total_offline_sales: string;
  computed_cash: string;
  has_flag: boolean;
  flagged_products: { product_name: string; derived_walkin_sold: number }[];
  payments: { account_name: string; is_primary_cash: boolean; amount: string }[];
  stock_counts_wastage: { product_name: string; wastage_pieces: number }[];
  stock_counts_remains: {
    product_name: string;
    product_category: string;
    remains_pieces: number;
    unit_price: string;
    remains_value: string;
  }[];
  total_remains_value: string;
  sales_by_product: DayOverviewSalesProduct[];
}

export interface DayOverviewTransaction {
  id: number;
  account_name: string;
  account_type: string;
  transaction_type: string;
  amount: string;
  note: string;
}

export interface DayOverview {
  date: string;
  operating_day: {
    id: number;
    status: OperatingDayStatus;
    started_at: string | null;
    stock_confirmed_at: string | null;
    carry_forward_confirmed_at: string | null;
  } | null;
  day_start_checks: DayOverviewStockCheck[];
  stock_ins: DayOverviewStockIn[];
  prep_logs: DayOverviewPrepLog[];
  display_stock: DayOverviewDisplayStock[];
  raw_stock: DayOverviewRawStock[];
  closing: DayOverviewClosing | null;
  pnl: {
    revenue: string;
    net_profit: string;
    cogs: string;
    gross_profit: string;
    commission_total: string;
    channel_discount: string;
  };
  transactions: DayOverviewTransaction[];
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
