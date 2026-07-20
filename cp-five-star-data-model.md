# CP Five Star — Data Model & Workflow Design (v1)

Assumptions I'm making (flag if wrong): single outlet, two roles only (STAFF, OWNER/ADMIN), one currency (BDT), delivery slips need approval but staff-entered daily closings can auto-lock unless flagged for variance.

---

## 1. Core Entities

### Outlet
Added now so multi-outlet expansion later doesn't require retrofitting every table.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | e.g. "CP Five Star — Dhanmondi" |
| address | str | |
| is_active | bool | |

### User
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | |
| role | enum | `STAFF`, `OWNER` |
| outlet_id | FK → Outlet, nullable | null for OWNER if they oversee multiple outlets; set for STAFF |
| phone | str | login identifier |
| is_active | bool | |

### Product
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | e.g. "Burger", "Wrap", "Crispy Chicken", "Buddy Combo", "Coke Can" |
| category | str | optional grouping |
| product_type | enum | `SINGLE` or `COMBO` |
| requires_preparation | bool | true for fried/prepared items (uses `PreparationLog`); false for items sold straight from stock — e.g. cold drinks, bottled water. Determines how "available to sell" is worked out at closing (see `DailyClosingStockCount` below). |
| selling_price | decimal | base/walk-in price; for a combo this is its own bundle price, not a sum of parts |
| is_active | bool | |

### ComboComponent
Only used when `product_type = COMBO`. Lets a combo sale still deduct the right components from `DisplayStock`, and lets COGS reflect what's actually inside it.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| combo_product_id | FK → Product (COMBO) | |
| component_product_id | FK → Product (SINGLE) | |
| quantity_per_combo | int | e.g. 1 Burger + 1 Wrap + 1 Drink |

**Effect on sale:** when a `DailyClosingSalesLine` references a combo, the system also decrements `DisplayStock` for each component (`quantity_sold × quantity_per_combo`) — same as if those pieces had been sold individually.

### PackDefinition (price-versioned)
Handles the fact that pack size / cost can change over time without rewriting history.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| product_id | FK → Product | |
| pieces_per_pack | int | e.g. 1 pack = 20 pieces |
| cost_per_pack | decimal | what NKG/CP charges the outlet |
| effective_from | date | |
| effective_to | date, nullable | null = currently active |

---

## 2. Stock In & Raw Stock

Renamed from "Delivery" — from the outlet's side this is receiving stock, whether or not a company slip exists.

### StockInRecord
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| stock_in_date | date | |
| submitted_by | FK → User (staff) | |
| status | enum | `DRAFT` (staff still editing), `PENDING` (submitted, awaiting owner review), `APPROVED`, `REJECTED` |
| reviewed_by | FK → User (owner), nullable | |
| reviewed_at | datetime, nullable | |
| slip_image | file, nullable | null when entirely manual (no company slip) |
| notes | text, nullable | |

### StockInItem
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| stock_in_record_id | FK → StockInRecord | |
| product_id | FK → Product | |
| source | enum | `SLIP_EXTRACTED`, `MANUAL` — per line, since one record can mix both |
| extracted_packs | decimal, nullable | raw OCR output, kept for audit even after staff edits it |
| confirmed_packs | decimal | the value that actually counts — staff can correct OCR misreads, or enter directly if manual |
| pack_definition_id | FK → PackDefinition | locks in cost at time of stock-in |

**Workflow:** staff optionally attaches a slip photo → OCR extracts line items into `StockInItem` rows (status stays `DRAFT`) → staff reviews/corrects `confirmed_packs` per line and can add further `MANUAL` lines (e.g. stock added with no slip at all) → only once staff is satisfied do they submit, moving status to `PENDING` → owner reviews `confirmed_packs` (not the raw OCR) and approves/rejects. **Stock rule:** `RawStock` only increments on `PENDING → APPROVED`, using `confirmed_packs`.

### RawStock (current balance, derived or cached)
| outlet_id | product_id | packs_available |
|---|---|---|
Simple running balance per outlet per product, updated by approved stock-in (+) and preparation log entries (−).

---

## 3. Preparation → Display Stock

Renamed from "Frying" — not every item is fried (rice, some sides are just prepared/portioned), and prep doesn't always consume a whole pack.

### PreparationLog
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| logged_by | FK → User | |
| product_id | FK → Product | |
| timestamp | datetime | |
| prep_unit | enum | `PACK` or `PIECE` — chosen per entry, not fixed per product |
| packs_used | decimal, nullable | set when prep_unit = PACK |
| pieces_prepared | int | when prep_unit = PACK: derived from packs_used × pieces_per_pack (editable for wastage); when prep_unit = PIECE: entered directly |

**Effect:** decrements `RawStock` (only meaningful when prep_unit = PACK — piece-level prep doesn't necessarily draw down a whole pack), increments `DisplayStock` for that product, same day.

### DisplayStock (current balance, derived or cached)
| outlet_id | product_id | pieces_available |
|---|---|---|
Running balance: `+pieces_prepared` (prep log) `− pieces_sold` (sales, all channels) for the day. Reset/rolled at day-end close.

---

## 4. Sales Channels & Daily Closing

### SalesChannel
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | Foodpanda, Foodi, Pathao, Walk-in/Counter |
| commission_rate | decimal | e.g. 0.20 for 20%; 0 for walk-in |
| settlement_type | enum | `DIRECT_TO_ACCOUNT` (app pays the outlet later, no cash/bKash/card collected at the counter) or `COLLECTED_AT_OUTLET` (rider/customer pays cash on pickup/delivery — staff physically receives it same day). **Admin-configurable per channel in Settings**, not hardcoded — current defaults: Foodpanda = `DIRECT_TO_ACCOUNT`; Foodi, Pathao, Walk-in = `COLLECTED_AT_OUTLET` (Foodi/Pathao riders pay cash on pickup in this outlet's experience, but that can vary by market/agreement, hence configurable). |
| integration_type | enum | `API_SYNC` or `MANUAL`. **v1: set to `MANUAL` for every channel**, including Foodpanda/Foodi — see scoping note below. |
| is_active | bool | |

### ChannelIntegration
Holds the connection state for channels once `integration_type` is switched to `API_SYNC`. **Not used in v1** — every channel is manual to start, so this table stays empty until Foodpanda/Foodi API access is arranged and turned on. Keeping the entity in the model now avoids a schema change later.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| channel_id | FK → SalesChannel | Foodpanda or Foodi, once enabled |
| credential_ref | str | reference to securely stored API credentials (client ID/secret) — never stored in plaintext in this table |
| status | enum | `CONNECTED`, `NEEDS_RECONNECT` (credentials expired/revoked), `NOT_CONFIGURED` |
| last_synced_at | datetime, nullable | |
| last_sync_status | enum, nullable | `SUCCESS`, `PARTIAL`, `FAILED` |
| last_sync_note | text, nullable | e.g. error message, or count of items synced |

**v1 scoping note:** first version is fully manual — staff enters Pathao, Foodi, and Foodpanda sales themselves, same as Pathao always would. Foodpanda and Foodi do have documented Partner APIs suited to this (order-history endpoints, reconciliation-oriented), gated behind account-manager approval rather than self-serve — worth revisiting once the manual flow is proven out and the API access process is worth the overhead. Pathao has no known public API for its food arm, so it likely stays manual regardless.

### ChannelPrice
Direct price override per product/combo per channel — this is what "add combo offers with separate prices per channel" actually needs, since a combo doesn't have a base price to apply a percentage discount to; it just *is* a price. Also covers simple channel-specific pricing without forcing everything through discount math.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| channel_id | FK → SalesChannel | |
| product_id | FK → Product | works for both SINGLE items and COMBOs |
| price | decimal | the price on this channel, full stop |
| effective_from | date | |
| effective_to | date, nullable | |
| is_active | bool | |

### ChannelPromotion
For simple ongoing % or fixed-amount discounts on regular (non-combo) items — e.g. "10% off Wrap on all channels."
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| channel_id | FK → SalesChannel, nullable | null = applies across all channels |
| product_id | FK → Product, nullable | null = applies to all products |
| discount_type | enum | `PERCENTAGE` or `FIXED_AMOUNT` |
| value | decimal | e.g. 20 (%) or 15 (৳) |
| effective_from | date | |
| effective_to | date, nullable | |
| is_active | bool | |

**Price resolution at time of sale (most specific wins):** `ChannelPrice` override (exact product+channel price, e.g. combo pricing) → `ChannelPromotion` (product+channel, then channel-only, then product-only) applied to `Product.selling_price` → plain `Product.selling_price`. Resolved price is snapshotted into `DailyClosingSalesLine.unit_price`, so history stays accurate even as prices/promos change later.

### OrderLevelOffer (reference only — not auto-calculated)
Covers things like "10% off orders above ৳500" on Foodpanda. **Important limitation:** this system tracks daily aggregate quantities per product per channel, not individual orders, so a threshold-based discount can't be computed line-by-line the way `ChannelPrice`/`ChannelPromotion` can. This entity is for the owner's own reference/reconciliation — it doesn't feed into `unit_price` automatically. If these offers are common enough to matter for accuracy, the more reliable fix is entering the channel's own daily payout total directly (via `ChannelSettlement`, for `DIRECT_TO_ACCOUNT` channels) or the daily discount total (via `DailyChannelDiscount`, for `COLLECTED_AT_OUTLET` channels) rather than trying to reverse-engineer it from per-item pricing.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| channel_id | FK → SalesChannel | |
| description | str | e.g. "10% off orders above ৳500" |
| threshold_amount | decimal, nullable | |
| discount_type | enum | `PERCENTAGE` or `FIXED_AMOUNT` |
| value | decimal | |
| effective_from | date | |
| effective_to | date, nullable | |

**Open question:** when a channel like Foodpanda runs its own promo, is commission calculated on the discounted price or the original menu price? This varies by platform agreement — worth confirming per channel, since it changes `commission_amount` and therefore net revenue. Flagging `commission_basis` (enum: `DISCOUNTED_PRICE` / `ORIGINAL_PRICE`) as a likely-needed field on `SalesChannel` once you confirm.

### DailyClosing (the "end of day" session)
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| closing_date | date | one per outlet per day |
| staff_id | FK → User | |
| status | enum | `DRAFT`, `SUBMITTED`, `LOCKED` |
| submitted_at | datetime, nullable | |
| has_variance_flag | bool | auto-set if counted stock ≠ expected stock |

### DailyClosingSalesLine
One row per (product, channel) combination sold via **Pathao, Foodi, or Foodpanda** that day, entered manually by staff — see the v1 scoping note below. Entered as step 2, after `DailyClosingStockCount` (step 1). Walk-in is deliberately excluded here; see `DailyClosingStockCount` above for how it's derived instead of manually tallied.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| daily_closing_id | FK | |
| product_id | FK → Product | |
| channel_id | FK → SalesChannel | Pathao, Foodi, or Foodpanda only |
| quantity_sold | int | |
| unit_price | decimal | snapshot of the resolved channel price at time of entry (see ChannelPrice/ChannelPromotion above) |
| gross_amount | decimal | = quantity × unit_price |
| commission_amount | decimal | = gross × channel.commission_rate (basis depends on `commission_basis`, see above) |
| net_amount | decimal | = gross − commission |
| source | enum | `STAFF_ENTRY` (v1 default, all channels) or `SYSTEM_DERIVED` (the Walk-in line, see below). `API_SYNC`/`STAFF_CORRECTED` reserved for a later phase — see v1 scoping note. |

### DailyChannelDiscount
Staff-entered, once per channel per closing — covers real-world discounts (order-value thresholds, combo deals, ad hoc promo codes) without needing to model every offer's exact rule. Staff reads the total off the app's own daily summary and types it in.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| daily_closing_id | FK | |
| channel_id | FK → SalesChannel | Pathao, Foodi, or Foodpanda |
| discount_amount | decimal | total discount given on this channel today, as staff reads it off the app |
| note | text, nullable | |

**Effect:** applied once, at the channel-day level: `channel_day_net_revenue = Σ(net_amount for that channel that day) − discount_amount`. This is deliberately not allocated back to individual line items — trying to split a lump discount across products would be guesswork the app itself doesn't expose. `ChannelPrice`/`ChannelPromotion` above still exist for setting expected/reference pricing (e.g. what the "add sold item" screen suggests as the likely unit price), but this manually-entered total is what actually reduces revenue in the P&L.

### DailyClosingStockCount
Staff's day-end physical count — the first thing entered at closing, before any channel sales. For `requires_preparation = true` items this counts today's prepared batch; for `requires_preparation = false` items (cold drinks etc.) it's simply what's left in stock, since those aren't made fresh daily.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| daily_closing_id | FK | |
| product_id | FK → Product | |
| available_pieces | int | system: today's `PreparationLog` total (prepared items) or current stock balance (non-prepared items) |
| wastage_pieces | int | staff-entered — spoiled, dropped, burnt, etc. Entered directly, not lumped into variance. |
| remains_pieces | int | staff-entered — physical count of what's left. (Previously called "counted"; renamed since that's how staff actually thinks of it.) |
| app_channel_sold | int | system: filled in once Pathao/Foodi/Foodpanda quantities are entered (see `DailyClosingSalesLine`) — this table's row is created at count time but this field updates after step 2 |
| derived_walkin_sold | int | = `available_pieces − wastage_pieces − remains_pieces − app_channel_sold`; only meaningful once `app_channel_sold` is filled in |
| flag | bool | true if `derived_walkin_sold < 0` (impossible — miscount, unrecorded app sale, or unlogged wastage) |

**On submit:** for each product with `derived_walkin_sold > 0`, the system auto-creates a `DailyClosingSalesLine` with `channel = Walk-in`, `quantity_sold = derived_walkin_sold`, `source = SYSTEM_DERIVED`, priced at the resolved Walk-in channel price. This keeps every downstream report (P&L, sales report) reading from the same table regardless of whether a line was synced, typed in, or derived.

### PaymentEntry
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| daily_closing_id | FK | |
| method | enum | `CASH`, `BKASH`, `CARD` |
| amount | decimal | for `BKASH`/`CARD`: staff-entered directly. For `CASH`: **system-computed**, not typed in — see formula below. Still stored as a normal row so reports read the same way regardless of method. |

**Payment screen calculation, in order:**
```
total_sale            = Σ net_amount across ALL channels today (Pathao + Foodi + Foodpanda + Walk-in derived)
online_payments       = Σ net_amount for channels where settlement_type = DIRECT_TO_ACCOUNT (Foodpanda by default)
total_offline_sales   = total_sale − online_payments   (shown as its own field — what should end up as cash/bKash/card)
cash_amount           = total_offline_sales − bkash_amount − card_amount   (auto-calculated once staff enters bKash & card)
```
`total_sale`, `online_payments`, and `total_offline_sales` are all system-computed and shown read-only; staff only ever types `bkash_amount` and `card_amount`. **Dependency:** because Walk-in revenue depends on the stock count, and total_sale depends on Walk-in, the payment screen can only show final numbers once both the count step and the online-sell step are done — matches the closing flow order (count → online sell → walk-in → payments).

**Trade-off worth flagging:** since cash is now derived rather than independently counted, there's no built-in check anymore comparing "cash that should be in the drawer" against "cash actually counted" — that comparison caught shortages/miscounts in the earlier design. If that matters, a `physical_cash_counted` field (staff re-counts the drawer, compared against the computed `cash_amount`) could be added back as an optional step; leaving it out for now per your simplification.

### ChannelSettlement
Tracks the actual payout from each delivery app, separate from the day the sale happened. This lets you reconcile "what the app owes us" vs "what they actually paid."
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| channel_id | FK → SalesChannel | |
| period_start | date | payout period the app is settling (e.g. weekly) |
| period_end | date | |
| expected_amount | decimal | Σ net_amount from DailyClosingSalesLine for that channel/period |
| received_amount | decimal, nullable | actual amount paid out by the app |
| received_date | date, nullable | |
| status | enum | `PENDING`, `RECEIVED`, `PARTIAL`, `DISPUTED` |
| notes | text, nullable | for shortfalls/disputes |

---

## 5. Costs

### CostCategory
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | Rent, Salary, Gas, Oil, Electrician, Repairs, Other |
| cost_type | enum | `FIXED`, `VARIABLE`, `ADHOC` |

### Expense
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| date | date | |
| category_id | FK → CostCategory | |
| amount | decimal | |
| description | text, nullable | |
| entered_by | FK → User | |
| recurring | bool | true for things like monthly rent/salary, so they auto-populate each period |

---

## 6. Workflow States

**Stock In:** `DRAFT` (staff attaching slip / correcting OCR / adding manual lines) → `PENDING` (staff submits — no further staff edits) → `APPROVED` (stock +, using confirmed quantities) or `REJECTED` (no stock effect, record kept for audit)

**Preparation:** logged in real-time, immediately moves raw → display stock (no approval needed — staff-level operational action); pack-based entries decrement RawStock, piece-based entries don't

**Daily Closing:** `DRAFT` (staff counts remains + logs wastage per product first → enters Pathao/Foodi/Foodpanda sales, which fills in `app_channel_sold` and makes Walk-in computable → enters each channel's daily discount total → enters cash/bKash/card payments, now reconcilable) → `SUBMITTED` (staff finalizes) → `LOCKED` (auto-locks if no count-flag and no payment mismatch, or owner reviews first if either is flagged)

---

## 7. Profit & Loss (derived, not stored raw)

For a given period (day/week/month):
```
Revenue        = Σ (channel_day_net_revenue) across all channels/days
                 where channel_day_net_revenue = Σ net_amount (DailyClosingSalesLine) − DailyChannelDiscount.discount_amount
COGS           = Σ (packs consumed via PreparationLog × cost_per_pack) + combo components deducted via ComboComponent
Gross Profit   = Revenue − COGS
Fixed Costs    = Σ Expense where category.cost_type = FIXED
Variable Costs = Σ Expense where category.cost_type = VARIABLE
Adhoc Costs    = Σ Expense where category.cost_type = ADHOC
Net Profit     = Gross Profit − Fixed − Variable − Adhoc
```
This is accrual-based (revenue counted the day it's sold, not the day the app pays out). Run a separate **settlement reconciliation report** off `ChannelSettlement` — flags any `expected_amount` vs `received_amount` mismatch per channel/period, independent of the P&L.

---

## Decisions locked in
1. **App settlements tracked separately** — `ChannelSettlement` added; P&L stays accrual-based, settlement variance is its own report.
2. **Wastage is now an explicit input** — staff enters `wastage_pieces` directly at closing, separate from the physical count. No reason code (burnt vs dropped vs expired) for now — just a quantity.
3. **Multi-outlet ready** — `Outlet` entity added; `outlet_id` threaded through the operational tables.
4. **Stock In replaces Delivery** — supports slip-OCR-extracted lines, manual lines, or a mix in one record; staff edits before submitting, owner only ever reviews the confirmed values, not raw OCR.
5. **Preparation replaces Frying** — supports both pack-based and piece-based logging per entry; non-prepared items (cold drinks) skip this entirely via `requires_preparation = false`.
6. **Walk-in is never manually tracked** — staff counts remains + logs wastage first, then enters Pathao/Foodi/Foodpanda sales; Walk-in quantity and revenue are derived (`available − wastage − remains − app sales`), removing a data-entry burden that's genuinely hard to do accurately during a rush.
7. **Combo & channel-specific pricing** — combos are just Products with `product_type = COMBO` and a `ComboComponent` breakdown for stock/COGS purposes; `ChannelPrice` gives a direct per-channel price (needed for combos), `ChannelPromotion` covers simple ongoing discounts as a reference/expected price.
8. **Order-value threshold discounts handled via manual daily total, not per-order modeling** — `DailyChannelDiscount` lets staff enter the actual discount total per channel per day (read off the app), applied once at the channel-day level rather than reverse-engineered per line item. `OrderLevelOffer` stays as owner-facing reference only.
9. **Payment collection matches settlement type, configurable per channel** — whichever channels are `COLLECTED_AT_OUTLET` (Foodi, Pathao, Walk-in by default) feed `total_offline_sales`; `DIRECT_TO_ACCOUNT` channels (Foodpanda by default) are subtracted out as `online_payments` and reconciled via `ChannelSettlement` instead. Admin can flip any channel's `settlement_type` in Settings rather than it being hardcoded. Cash is now computed (`total_offline_sales − bKash − card`), not typed in — see the trade-off note under `PaymentEntry`.
10. **v1 is fully manual, API sync deferred** — `integration_type = MANUAL` for every channel at launch; staff enters Pathao/Foodi/Foodpanda sales the same way. `ChannelIntegration`/`API_SYNC` stay modeled but unused, so switching a channel on later (once Foodpanda/Foodi API access is arranged) doesn't need a schema change — just a fallback to manual entry stays available regardless, for whenever a sync would fail.
