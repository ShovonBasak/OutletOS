export type Role = "STAFF" | "OWNER";

export interface User {
  id: number;
  name: string;
  role: Role;
  outlet: number | null;
  phone: string;
  is_active: boolean;
}

export interface Outlet {
  id: number;
  name: string;
  address: string;
  is_active: boolean;
}

export type ProductType = "SINGLE" | "COMBO";
export type TrackingMode = "RECIPE_LINKED" | "PERIODIC_COUNT";

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
}

export interface ComboComponent {
  id: number;
  combo_product: number;
  component_product: number;
  component_name: string;
  quantity_per_combo: number;
}

export interface Product {
  id: number;
  name: string;
  category: string;
  product_type: ProductType;
  requires_preparation: boolean;
  selling_price: string;
  is_active: boolean;
  components: ComboComponent[];
  recipes: Recipe[];
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
  base_unit: string;
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
}

export interface StockInRecord {
  id: number;
  outlet: number;
  stock_in_date: string;
  submitted_by: number;
  submitted_by_name: string;
  status: StockInStatus;
  reviewed_by: number | null;
  reviewed_at: string | null;
  slip_image: string | null;
  notes: string;
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

export interface RawStock {
  id: number;
  ingredient: number;
  ingredient_name: string;
  base_unit: string;
  quantity_available: string;
}

export interface DisplayStock {
  id: number;
  product: number;
  product_name: string;
  pieces_available: number;
}

// ---- Packaging (periodic count) -------------------------------------------
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
  method: "CASH" | "BKASH" | "CARD";
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

export interface Expense {
  id: number;
  outlet: number;
  date: string;
  category: number;
  category_name: string;
  cost_type: string;
  amount: string;
  description: string;
  recurring: boolean;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
