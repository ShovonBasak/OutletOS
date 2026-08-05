export type Role = "STAFF" | "OWNER";

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
  /** Full active ProductPrice object, null if no price set yet. */
  active_price: ProductPrice | null;
  is_active: boolean;
  components: ComboComponent[];
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
  stock_checks: DayStartStockCheck[];
}

// A day-start-stock row (the reconcile list, before it becomes a check).
export interface DayStartStockRow {
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  ingredient_group: IngredientGroup;
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
  paid_from_account: number | null;
  paid_from_account_name: string | null;
  created_at: string;
  items: StockInItem[];
  unresolved_count: number;
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

export type IngredientGroup = "BEVERAGE" | "CHICKEN_PIECE" | "SNACK" | "BURGER_WRAP" | "SUPPLY" | "OTHER";

export interface RawStock {
  id: number;
  ingredient: number;
  ingredient_name: string;
  ingredient_display_name: string;
  ingredient_group: IngredientGroup;
  base_unit: string;
  tracking_mode: TrackingMode;
  quantity_available: string;
  pieces_per_pack: string | null;
  cost_per_base_unit: string | null;
}

export interface DisplayStock {
  id: number;
  product: number;
  product_name: string;
  product_category: string;
  pieces_available: number;
}

// ---- Packaging (periodic count) -------------------------------------------
export interface PackagingLevel {
  ingredient: number;
  ingredient_name: string;
  base_unit: string;
  pieces_per_pack: string | null;
  current_qty: string;
  source: "counted" | "stock_in_derived";
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
  available_pieces: number;
  wastage_pieces: number;
  remains_pieces: number;
  app_channel_sold: number;
  derived_walkin_sold: number;
  flag: boolean;
  wastage_cost: string;
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
  commission_amount: string;
  net_amount: string;
  source: "STAFF_ENTRY" | "SYSTEM_DERIVED";
}

export interface PaymentEntry {
  id: number;
  account: number;
  account_name: string;
  account_type: string;
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
  submitted_at: string | null;
  has_variance_flag: boolean;
  stock_counts: StockCount[];
  sales_lines: SalesLine[];
  channel_discounts: { id: number; channel: number; channel_name: string; discount_amount: string; note: string }[];
  payments: PaymentEntry[];
  total_sale: string;
  channel_day_net_revenue: string;
  online_payments: string;
  total_offline_sales: string;
  computed_cash: string;
  has_flag: boolean;
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
  discount: string;
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

export interface ChannelPrice {
  id: number;
  channel: number;
  channel_name: string;
  product: number;
  product_name: string;
  price: string;
  effective_from: string;
  effective_to: string | null;
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

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
