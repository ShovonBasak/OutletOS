# CP Five Star — Shop Management System

Shop management system for a CP Five Star fried chicken franchise outlet in Dhaka, Bangladesh (single outlet at launch, built to extend to more). One staff member runs day-to-day operations; the owner reviews/approves remotely.

This file is context for Claude Code sessions working in this repo. **The authoritative specs are `updated-cp-five-star-data-model.md` (schema + business rules) and `updated-cp-five-star-full-sitemap.html` (UI/interaction).** They supersede the older `cp-five-star-data-model.md` / `cp-five-star-full-sitemap.html`. This CLAUDE.md is a condensed handoff pointing at both — when in doubt, defer to the `updated-*` files. If something here conflicts with existing code, flag it rather than silently picking one.

## Stack

- Backend: Django REST Framework, PostgreSQL (dev on SQLite). Apps: `accounts`, `catalog`, `stock`, `sales`, `closing`, `costs`, `reports`.
- Frontend: Next.js (App Router, TypeScript, Tailwind CSS). `frontend/src/app/staff/*` (mobile) and `owner/*` (mobile + desktop).
- Auth: role-based — `STAFF`, `OWNER` (phone-number login, JWT).

## Core assumptions

- Single outlet at launch, multi-outlet-ready schema (`outlet_id` threaded through operational tables)
- Currency: BDT (৳)
- v1 is **fully manual entry** — no third-party API integrations (schema is API-ready but unused)
- Staff role: one person handles the gated daily flow (start day → stock → prep → closing)
- Owner role: reviews/approves remotely, manages catalog/recipes/pricing/settings, views reports

---

## Data model (the important shift: Ingredient vs Product)

**What you *buy/stock* is an `Ingredient`; what you *sell* is a `Product`; a `Recipe` links them.** Stock, packs, and COGS all flow through ingredients/recipes — a Product does **not** have its own pack.

### Catalog (`catalog/models.py`)
- **Outlet** — `id, name, address, is_active`
- **Product** — `id, name, category, product_type (SINGLE/COMBO), requires_preparation, selling_price, is_active`. Sellable/priced thing.
- **ComboComponent** — `combo_product, component_product, quantity_per_combo`. Selling a combo deducts each component from DisplayStock.
- **Ingredient** — `id, name, base_unit (str), tracking_mode (RECIPE_LINKED/PERIODIC_COUNT), is_active`. `base_unit` is chosen recipe-friendly (mayo = "portion", not "bottle") so recipe lines stay whole numbers. `cost_per_base_unit` = active pack's `cost_per_pack / pieces_per_pack`.
- **SupplierProductAlias** — `ingredient, alias_text, is_active`. Maps supplier slip wording → ingredient; self-improving (resolve once, remembered).
- **PackDefinition** — belongs to **Ingredient** now. `ingredient, pieces_per_pack (decimal, in base_unit), cost_per_pack, effective_from/to`. Price-versioned (editing closes current row + opens new).
- **Recipe** (bill of materials) — `product, ingredient, quantity_per_unit`. Every Product has ≥1 row (a direct-stock drink has one at qty 1). e.g. 5★ Burger ← 1 bun + 1 patty + 1 portion mayo; Chicken Ball (4pc) ← 4 raw balls + 1 bamboo stick.

### Operating day & gating (`stock/models.py`)
- **OperatingDay** — one per outlet/date. `status: NOT_STARTED → STOCK_CONFIRMED → IN_PROGRESS → CLOSED`. Gates Stock In (needs ≥ STOCK_CONFIRMED), Prep + Closing (need IN_PROGRESS). Completed steps stay editable — gating blocks skipping *ahead*, not going back.
- **DayStartStockCheck** — morning reconcile per ingredient: `system_carried_qty` (yesterday's RawStock), `confirmed_qty` (staff), `discrepancy_qty` (computed), `discrepancy_reason` (required if ≠0). On confirm: `RawStock = confirmed_qty`. Shortfalls feed the **Shrinkage** P&L line (distinct from wastage).

### Stock In & Raw Stock (`stock/models.py`) — ingredient-based
- **StockInRecord** — `outlet, stock_in_date, submitted_by, status (DRAFT/PENDING/APPROVED/REJECTED), reviewed_by/at, slip_image, notes`. `unresolved_lines` blocks DRAFT→PENDING.
- **StockInItem** — `ingredient (nullable = "Unrecognized"), raw_extracted_text, source (SLIP_EXTRACTED/MANUAL), unit_captured (PACK/PIECE), extracted_quantity, confirmed_quantity, pack_definition (nullable)`. Slip says "1 pack" → convert via PackDefinition. A PACK line with no pack yield prompts "how many pieces per pack?" (creates the PackDefinition inline) and blocks submit until resolved, same as an unresolved ingredient.
- **RawStock** — running balance **per ingredient**, in base_unit (`quantity_available`). `+` on approved stock-in, `−` on prep (via Recipe).

### Preparation → Display Stock (`stock/models.py`)
- **PreparationLog** — `product, source (FRESH/CARRIED_FORWARD), carried_forward_from, leftover_available_pieces, prep_unit (PACK/PIECE), packs_used, pieces_prepared, wastage_pieces`. FRESH decrements RawStock per Recipe (`pieces × quantity_per_unit` per ingredient); **PACK only valid for single-ingredient recipes**, multi-ingredient items log finished PIECEs. CARRIED_FORWARD moves yesterday's leftovers with NO ingredient deduction; partial move → shortfall auto-fills `wastage_pieces`.
- **DisplayStock** — ready-to-sell pieces per product per day.

### Packaging & supplies (`stock/models.py`) — periodic count
- **PeriodicStockCheck** — for `PERIODIC_COUNT` ingredients (bags, sachets) with no fixed per-product ratio. Staff reports what's *left*; `consumed_since_last_check = prev + stock_in_since − counted`. "Bundle finished" one-tap subtracts a pack. Reported as `consumption_ratio` (per 100 sold) vs baseline — a signal, not proof.

### Sales, pricing & closing (`sales/models.py`, `closing/models.py`) — unchanged from prior design
- **SalesChannel** (`commission_rate`, `settlement_type` DIRECT_TO_ACCOUNT/COLLECTED_AT_OUTLET admin-configurable, `integration_type` MANUAL in v1, `commission_basis`), **ChannelIntegration** (unused v1), **ChannelPrice** (direct per-channel override, how combos price), **ChannelPromotion**, **OrderLevelOffer** (reference only).
- Price resolution (most specific wins): ChannelPrice → ChannelPromotion (product+channel → channel → product) on selling_price → plain selling_price. Snapshotted into `DailyClosingSalesLine.unit_price`. See `sales/pricing.py`.
- **DailyClosing** (`DRAFT/SUBMITTED/LOCKED`, `has_variance_flag`). Closing flow (each its own gated screen): Count remains & wastage → Online sell (Pathao/Foodi/Foodpanda) + per-channel discount → Walk-in (view-only, derived) → Payments.
- **DailyClosingStockCount** — `available_pieces (system), wastage_pieces, remains_pieces, app_channel_sold (system), derived_walkin_sold = available − wastage − remains − app_sold, flag (if <0)`. On submit, positive walk-in auto-creates a `SYSTEM_DERIVED` DailyClosingSalesLine at the Walk-in price. **Walk-in is never manually entered.**
- **DailyChannelDiscount** — per channel/day lump total; applied once at channel-day level.
- **PaymentEntry** — bKash/Card typed; **Cash computed** = `total_offline_sales − bkash − card`. See `closing/services.py::recompute_closing`.
- **ChannelSettlement** — reconcile app payouts vs expected (own report, not folded into P&L).

### Costs (`costs/models.py`) — **CostCategory** (`cost_type` FIXED/VARIABLE/ADHOC), **Expense**.

---

## Workflow states

- **Staff day (`OperatingDay`):** NOT_STARTED → (Day-Start Stock confirm) STOCK_CONFIRMED → (Prep carry-forward) IN_PROGRESS → (closing locked) CLOSED. Skipping ahead is blocked; going back to edit is allowed.
- **Stock In:** DRAFT → PENDING → APPROVED/REJECTED. RawStock only moves on APPROVED (confirmed_quantity → base units).
- **Preparation:** real-time, no approval.
- **Daily Closing:** DRAFT → SUBMITTED → LOCKED (auto-locks unless a count flag / payment mismatch needs owner review).

## P&L (derived, `reports/views.py`)

```
Revenue     = Σ channel_day_net_revenue (Σ net_amount − DailyChannelDiscount)
COGS        = Σ over units SOLD: Recipe.quantity_per_unit × ingredient cost_per_base_unit
              (+ combos via ComboComponent → component recipes)
GrossProfit = Revenue − COGS
Wastage     = closing wastage_pieces + carry-forward wastage_pieces, at recipe cost
Shrinkage   = Σ DayStartStockCheck shortfalls (>0) × ingredient cost_per_base_unit
Packaging   = Σ PeriodicStockCheck consumption × cost  (own line)
NetProfit   = GrossProfit − Wastage − Shrinkage − Fixed − Variable − Adhoc
```
Three separate loss categories (COGS / Wastage / Shrinkage) — deliberately not merged. Accrual-based; settlement variance is a separate report.

---

## UI conventions (match these — see `updated-cp-five-star-full-sitemap.html`)

- **Terminology:** "Ingredient" (received) vs "Product" (sold); "Stock In" not Delivery; "Preparation log" not Fry log; "Remains" not Counted; "Online sell" for the combined Pathao/Foodi/Foodpanda screen.
- **Staff mobile — gated flow, not free nav.** First launch shows "▶ Start your day" → Day-Start Stock → Prep Carry-Forward, then bottom tabs (Home / Stock In / Prep log / Closing) unlock; locked tabs show 🔒. Operating-day context lives in `frontend/src/lib/staffDay.tsx` (layouts can only default-export in App Router). Closing is itself a gated hub.
- **Large lists (23+ items)** use search + category chips + compact grid, rows go light-green when filled (`ProductListFilter`).
- **Owner setup flow = 4 screens:** Extract Ingredients (clean name + base_unit + pieces_per_pack) → Import Menu → Map Recipes (drag/tap-assign, **names only, no quantities**) → Edit Recipe (per product, `quantity_per_unit` fields). Owner desktop sidebar is a collapsible accordion; every owner feature has mobile + desktop.
- **Anomaly flags never silently pass:** impossible walk-in, day-start discrepancy without reason, unresolved stock-in ingredient, missing pack yield, packaging spike — each blocks or visibly flags.
- **Visual language:** ticket/receipt cards (dashed border, notches); rotated ink-stamp status badges; monospace for figures. Brand colors: brick-red chrome `#7A2420` (headers/nav), bright red `#DE2E27` (logo only, never buttons), gold `#F0C419` (pending/prep), near-black `#241512` + gold (primary buttons), green `#3F6B3F` (approved), rust-orange (`chili` `#C9601C`) for variance/flags. Tailwind has no `rust` — use `chili`.

## Deferred (don't build now)
- API sync for Foodpanda/Foodi (`ChannelIntegration`/`integration_type` ready but unused).
- Physical cash count vs. computed cash reconciliation.
- Per-order threshold discount modeling (use `DailyChannelDiscount` lump total instead).

## Open questions for the owner (not for Claude to guess)
- `commission_basis` per channel (discounted vs original price).
- Whether wastage / day-start discrepancy need finer reason codes later.
