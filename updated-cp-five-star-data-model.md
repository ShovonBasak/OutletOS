# CP Five Star — Data Model & Business Logic (Final, v1)

Single outlet at launch (multi-outlet-ready schema), two roles (`STAFF`, `OWNER`), currency BDT (৳), v1 is fully manual entry (no third-party API integrations — see decision 10). This is the authoritative reference for both schema and workflow rules; `cp-five-star-full-sitemap.html` is the matching UI reference, and `CLAUDE.md` is a condensed handoff pointing at both. Section 8 (UI Conventions) and the numbered decisions at the bottom capture the *why* behind anything that looks non-obvious — read those before changing something that seems inconsistent, since it's likely intentional and already reasoned through once.

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

### OperatingDay
Gates the whole staff daily flow — not just Closing. One row per outlet per date, created the first time staff taps "Start your day."
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| date | date | |
| status | enum | `NOT_STARTED` → `STOCK_CONFIRMED` (day-start stock done) → `IN_PROGRESS` (prep carry-forward done, full app unlocked) → `CLOSED` (closing locked) |
| started_by | FK → User, nullable | |
| started_at | datetime, nullable | |
| stock_confirmed_at | datetime, nullable | |
| carry_forward_confirmed_at | datetime, nullable | |
| daily_closing_id | FK → DailyClosing, nullable | set once closing is created |

**Gating rule:** Stock In / Preparation Log / Closing are only reachable once `status ≥ STOCK_CONFIRMED` (Stock In only strictly needs `STOCK_CONFIRMED`; Preparation Log and Closing need `IN_PROGRESS`). This is enforced in the UI, not just documented — see section 8 below. **Completed steps stay editable** even after the day moves on — gating blocks skipping *ahead*, not going back to fix something.

### DayStartStockCheck
The morning reconciliation step. `RawStock` (see Ingredients section below) is a continuously-running balance and doesn't reset daily — but staff explicitly confirming it each morning catches overnight drift (spoilage, miscounts) before the day's numbers build on top of a wrong base.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| operating_day_id | FK → OperatingDay | |
| ingredient_id | FK → Ingredient | |
| system_carried_qty | decimal | = yesterday's closing `RawStock` balance for this ingredient, in its `base_unit` |
| confirmed_qty | decimal | staff-entered; defaults to `system_carried_qty` via a "Replicate" bulk action, editable per row |
| discrepancy_qty | decimal | = `system_carried_qty − confirmed_qty` (computed, not entered). Positive = shortfall (stock is missing). Negative = surplus (more found than expected — rarer, usually means yesterday's closing count was off). |
| discrepancy_reason | enum, required if discrepancy_qty ≠ 0 | `SPOILED`, `MISCOUNTED_YESTERDAY`, `SURPLUS_FOUND`, `OTHER` (pairs with a free-text note for `OTHER`) — staff must pick one before the row counts as resolved; this is what makes the loss reportable instead of just a silent number change |
| note | text, nullable | required when reason = `OTHER`, optional otherwise |

**This is deliberately not the same thing as `DailyClosingStockCount.wastage_pieces`.** That field is finished-product loss during the day (a burnt Crispy Fry). This is raw-ingredient loss discovered before any preparation happens today — different layer of the supply chain, and conflating the two would hide *where* loss is actually occurring (kitchen wastage vs. storage/inventory shrinkage), which is exactly the kind of thing an owner needs to be able to tell apart.

**On confirm:** `RawStock.quantity_available` is set to `confirmed_qty` for each ingredient (an explicit, auditable reconciliation — not a silent overwrite). Any row with `discrepancy_qty ≠ 0` requires a `discrepancy_reason` before the whole `DayStartStockCheck` step can be marked done — this mirrors the same "don't let an anomaly pass silently" pattern used for the impossible-Walk-in flag at closing.

**Where it shows up in reporting:** `shrinkage_cost = Σ (discrepancy_qty × ingredient's effective cost per base unit)` for the day, where `discrepancy_qty > 0` (shortfalls only — a surplus doesn't reduce cost, it flags a counting problem instead and shouldn't quietly boost profit). This is its own P&L line, separate from COGS — COGS is the cost of what was actually sold; shrinkage is ingredient cost lost before it ever became a sale. See section 7 below.

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

---

## 1a. Ingredients, Supplier Aliases & Recipes (Bill of Materials)

This is the piece that was missing: what you physically *receive* from the supplier (bun, patty, mayo — each a separate item, each possibly named differently on the invoice than in your system) is not the same thing as what you *sell* (a Burger). `Product` stays the sellable/priced thing customers order. Everything received, stocked, and consumed now flows through a new `Ingredient` entity instead.

### Ingredient
The canonical, internal name for a raw material — one row per real-world thing you buy, regardless of what any given supplier calls it.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| name | str | canonical internal name, e.g. "Crispy Chicken Patty (5in)", "Burger Bun", "Mayonnaise", "Medium Bag" |
| base_unit | str | the countable unit recipes should be written in terms of — **chosen for what's natural in a recipe, not necessarily the physical purchase container.** `piece` for bun/patty/bamboo stick (already discrete). For something like mayo, don't use `bottle` — use `portion` (or whatever the kitchen actually thinks in), so a recipe can say "1 portion" instead of "0.045 bottle." This one choice, made once per ingredient at Extract Ingredients, is what keeps every recipe line downstream a clean whole number. |
| tracking_mode | enum | `RECIPE_LINKED` (default — bun, patty, mayo: consumption computed automatically via `Recipe` × units prepared/sold) or `PERIODIC_COUNT` (packaging materials, condiment packets: no fixed per-product ratio exists — order size varies, and per-transaction tracking isn't happening — so consumption is inferred from periodic manual stock counts instead. See `PeriodicStockCheck` below.) |
| is_active | bool | |

### SupplierProductAlias
Solves the naming-mismatch problem directly. One ingredient can have several known aliases; OCR/manual entry matches against this table first.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| ingredient_id | FK → Ingredient | |
| alias_text | str | text exactly as it tends to appear on a slip, e.g. "CKN PATTY 5IN 10PC" |
| is_active | bool | |

**Matching flow at Stock In:** OCR-extracted line text is matched against `alias_text` (exact match first, fuzzy/normalized match as fallback — strip case, punctuation, common abbreviations). A match resolves straight to the `Ingredient` and its current `PackDefinition`. **No match → flagged as "Unrecognized item"**: staff picks the right `Ingredient` from a list (or creates a new one) once; that selection is saved as a new `SupplierProductAlias` automatically, so the same wording auto-resolves next time. This is a self-improving mapping — coverage gets better the more slips go through it, and nobody has to pre-load every possible supplier naming variant up front.

### PackDefinition (price-versioned) — moved from Product to Ingredient
Handles the fact that pack size/cost can change over time without rewriting history. **Now belongs to `Ingredient`, not `Product`** — packs are received per ingredient (a pack of patties, a pack of buns), not per menu item.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| ingredient_id | FK → Ingredient | |
| pieces_per_pack | decimal | in the ingredient's `base_unit` — e.g. 10 (patty, unit=piece), 10 (bun, unit=piece), **22 (mayo, unit=portion — this is where the "1 bottle → 22 portions" fact actually lives now, not in the recipe)** |
| cost_per_pack | decimal | what the supplier charges |
| effective_from | date | |
| effective_to | date, nullable | null = currently active |

**One canonical entry point, one read-only display, one rare fallback:**
1. **Extract Ingredients** (the bulk slip-upload setup screen) — this is now the primary place: right when a raw supplier line gets cleaned up into a canonical ingredient name, both the `base_unit` (what are we even counting?) and `pieces_per_pack` (how many of those per pack?) are captured in the same row, same moment. Most ingredients should never need to be touched again after this.
2. **Map Recipes** — shows pack info as read-only context on each ingredient chip (useful to see while assigning recipes, e.g. confirming "yes, this is the same Bamboo Stick, 100/bag"), but doesn't let you edit it there, and — see below — doesn't need it to define a recipe anyway anymore.
3. **Stock In, as a fallback only** — covers the case where an ingredient reaches a slip without ever having gone through Extract Ingredients (e.g. resolved fresh via "Unrecognized item" mid-operation, well after initial setup). Still gates submission the same way, but should read as the exception path, not the expected one.

Editing `pieces_per_pack` (or `base_unit`) anywhere doesn't overwrite history — it closes the current row (`effective_to = today − 1`) and opens a new one (`effective_from = today`), consistent with how this field already handles price changes.

### Recipe (Bill of Materials)
Links a sellable `Product` to the `Ingredient`(s) it's actually made from, and how much of each one unit of the product consumes. Every `Product` — prepared or direct-stock — has at least one `Recipe` row; a direct-stock item like a cold drink just has exactly one row at `quantity_per_unit = 1` pointing to an ingredient that is, in effect, that same item. Keeping this uniform means stock deduction always works the same way, instead of having two different code paths for "simple" vs "composed" products.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| product_id | FK → Product | |
| ingredient_id | FK → Ingredient | |
| quantity_per_unit | decimal | how many of the ingredient's `base_unit` are consumed per 1 unit of the product — **entered directly, no pack involved.** Because `base_unit` was chosen at Extract Ingredients to be recipe-friendly, this is almost always a clean small number. |

**Worked example — the 5★ Burger:**
| Ingredient | base_unit | quantity_per_unit |
|---|---|---|
| Burger Bun | piece | 1 |
| Crispy Patty | piece | 1 |
| Mayonnaise | portion | 1 |

**Worked example — Chicken Ball (4pc):** this one's a good test of the principle, because "4 chicken balls need 1 bamboo stick" sounds like it should be a fraction (0.25 sticks per ball). It isn't, once the *product* is correctly understood — the sellable unit is "1 order of Chicken Ball (4pc)," not "1 ball." So:
| Ingredient | base_unit | quantity_per_unit |
|---|---|---|
| Chicken Ball (raw) | piece | 4 |
| Bamboo Stick | piece | 1 |

**Recipe definition is now explicitly two steps, not one screen doing both:**
1. **Map Recipes** (drag-and-drop / tap-to-assign) — purely association. Dragging an ingredient into a product's bucket creates the `Recipe` row with `quantity_per_unit` defaulted to `1`. No quantity, unit, or pack info shown at all — ingredients appear as plain names, nothing else. This screen's only job is fast bulk "which ingredients belong to which product," across potentially 20+ products and 30+ ingredients; anything beyond the name is a distraction from that one job.
2. **Edit Recipe** (reached from Products & packs, per product) — this is where `quantity_per_unit` actually gets set or corrected, e.g. changing Chicken Ball (raw) from the default `1` to the real `4`. Quantities are shown as plain always-editable number fields, no click-to-open step, since this screen exists specifically for that one job. Adding a *new* ingredient to the recipe still happens back in Map Recipes — Edit Recipe only adjusts quantities on ones already assigned.

This split matters because the two tasks have different rhythms: association is fast, bulk, and repetitive (good fit for drag-and-drop defaulting everything to 1); quantity-setting is slow, per-product, and needs full attention (bad fit for being bolted onto the same fast bulk screen). Conflating them was making the mapper feel heavier than it needed to.

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
| ingredient_id | FK → Ingredient, nullable | null while "Unrecognized" — see resolution flow below |
| raw_extracted_text | str | the exact OCR text for this line, kept regardless of whether it resolved — this is what future alias matching learns from |
| source | enum | `SLIP_EXTRACTED`, `MANUAL` — per line, since one record can mix both |
| unit_captured | enum | `PACK` or `PIECE` — **the same invoice can list different lines in different units** (e.g. patty as "1 pack", bun as "10 pieces" directly). This says which one was captured, so conversion knows whether to multiply by `pieces_per_pack` or take the number as-is. |
| extracted_quantity | decimal, nullable | raw OCR output in `unit_captured`'s unit, kept for audit even after staff edits it |
| confirmed_quantity | decimal | the value that actually counts — staff can correct OCR misreads, or enter directly if manual |
| pack_definition_id | FK → PackDefinition, nullable | locks in cost at time of stock-in; null if `unit_captured = PIECE` and no pack conversion applies |

**Resolution flow when `ingredient_id` is null ("Unrecognized item"):** staff sees the raw OCR text and picks the matching `Ingredient` (or creates one), which both fills in `ingredient_id` for this line **and** saves a new `SupplierProductAlias` for `raw_extracted_text` — so the same wording resolves automatically on the next slip. A `StockInRecord` can't move `DRAFT → PENDING` while it still has unresolved lines.

**The gap this closes:** a slip says "1 pack" — it never says how many pieces that makes. That has to live on the `Ingredient` (via `PackDefinition`), not be re-derived per slip. So:
- **`unit_captured = PACK` and the ingredient has no active `PackDefinition`** → the line can't resolve to a `pack_definition_id`, and blocks `DRAFT → PENDING` the same way an unresolved `ingredient_id` does. Staff sees an inline prompt right on that line: *"How many pieces does 1 pack make?"* — answering it creates the ingredient's first `PackDefinition` on the spot. This applies whether the ingredient is brand new (just resolved from "Unrecognized") or an existing one that was set up without ever specifying a yield.
- **`unit_captured = PACK` and a `PackDefinition` already exists** → no prompt, just shows the computed piece count for confirmation (e.g. "1 pack (10 pcs)"). Staff can still correct it inline if the supplier's pack size changed — see the versioning note under `PackDefinition` above.
- **`unit_captured = PIECE`** → no pack question at all, the captured number is used as-is (this is the bun case — some invoice lines state pieces directly, no pack conversion needed).

**Workflow:** staff optionally attaches a slip photo → OCR extracts line items into `StockInItem` rows, matched against `SupplierProductAlias` where possible (status stays `DRAFT`) → staff resolves any unrecognized lines **and** any missing pack yields, reviews/corrects `confirmed_quantity` per line, and can add further `MANUAL` lines (e.g. stock added with no slip at all) → only once every line is resolved (ingredient known, pack yield known where needed) do they submit, moving status to `PENDING` → owner reviews `confirmed_quantity` (not the raw OCR) and approves/rejects. **Stock rule:** `RawStock` only increments on `PENDING → APPROVED`, using `confirmed_quantity` converted to the ingredient's base unit via the locked-in `pack_definition_id`.

### RawStock (current balance, derived or cached)
| outlet_id | ingredient_id | quantity_available |
|---|---|---|
Running balance **per ingredient**, in that ingredient's `base_unit`. Updated by approved stock-in (+) and preparation entries (−, fanned out through each product's `Recipe` — see below).

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
| source | enum | `FRESH` (actually prepared today, consumes ingredients per Recipe) or `CARRIED_FORWARD` (yesterday's leftover `remains_pieces`, moved into today's `DisplayStock` with **no** ingredient deduction — those ingredients were already spent when it was originally prepared) |
| carried_forward_from_id | FK → DailyClosingStockCount, nullable | set when source = CARRIED_FORWARD; links back to the specific closing-day count row this came from, for audit |
| leftover_available_pieces | int, nullable | only for CARRIED_FORWARD — system value, = yesterday's `remains_pieces` for this product |
| prep_unit | enum | `PACK` or `PIECE`, only relevant when source = FRESH. **`PACK` only valid when the product's `Recipe` has exactly one ingredient row** (e.g. Crispy Fry ← just "raw chicken") — it's shorthand for "used N packs of that one ingredient." Multi-ingredient products (Burger) must use `PIECE`: staff logs how many finished units they assembled, full stop — they never touch ingredient math. |
| packs_used | decimal, nullable | set when prep_unit = PACK; refers to the product's single recipe ingredient's own pack |
| pieces_prepared | int | when prep_unit = PACK: derived from packs_used × that ingredient's pieces_per_pack; when prep_unit = PIECE: entered directly; when source = CARRIED_FORWARD: **staff-chosen quantity actually moved**, defaults to `leftover_available_pieces` but editable down |
| wastage_pieces | int, nullable | only for CARRIED_FORWARD — computed as `leftover_available_pieces − pieces_prepared`. If staff moves less than the full leftover (some spoiled overnight, doesn't look sellable, etc.), the difference lands here automatically rather than just vanishing from the count. |

**Effect:** `FRESH` entries decrement `RawStock` **per ingredient**, computed by walking the product's `Recipe`: for each `Recipe` row, `RawStock[ingredient] −= pieces_prepared × quantity_per_unit`. Preparing 20 Burgers deducts 20 buns, 20 patties, and `20 × 0.0455 ≈ 0.91` bottles of mayo — all from one staff action, no per-ingredient entry. `CARRIED_FORWARD` entries skip that deduction entirely (the ingredients are already gone from yesterday), but still increment `DisplayStock` for the product by `pieces_prepared` (not the full leftover, if less was chosen), same day.

**Carry-forward flow:** at the start of a new `OperatingDay`, for every product where yesterday's `DailyClosingStockCount.remains_pieces > 0`, the Preparation Log screen surfaces a suggested `CARRIED_FORWARD` entry with `leftover_available_pieces` shown and `pieces_prepared` pre-filled to the same value (editable down). Staff confirms — or lowers the quantity, in which case the shortfall auto-fills as `wastage_pieces` rather than needing a separate entry. This is a required step before `OperatingDay.status` can reach `IN_PROGRESS`.

### DisplayStock (current balance, derived or cached)
| outlet_id | product_id | pieces_available |
|---|---|---|
Running balance: `+pieces_prepared` (prep log) `− pieces_sold` (sales, all channels) for the day. Reset/rolled at day-end close. Note this is still tracked per **Product** (what's ready to sell), while `RawStock` above is tracked per **Ingredient** (what's left to make more of) — two different layers, don't conflate them.

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

**The full staff day, in order (this is new — previously each piece was gated internally but nothing tied the whole day together):**
```
OperatingDay.NOT_STARTED
  → staff taps "Start your day" (small link nearby: view yesterday's summary, read-only)
  → Day-Start Stock: confirm/replicate ingredient RawStock (DayStartStockCheck) → status = STOCK_CONFIRMED
     (Stock In becomes reachable here — deliveries can arrive any time)
  → Preparation Carry-Forward: move yesterday's DailyClosingStockCount.remains_pieces into today's
    DisplayStock via CARRIED_FORWARD PreparationLog entries → status = IN_PROGRESS
     (Preparation Log and Closing become reachable here; full app unlocked)
  → [rest of the day: Stock In + Preparation Log used freely, in any order, as needed]
  → Daily Closing (see below) → LOCKED → OperatingDay.status = CLOSED
```
**Skipping ahead is blocked in the UI** (Stock In/Preparation/Closing stay visibly locked until their gate is met), **but every completed step stays editable** — staff can go back and fix a Day-Start Stock entry or a Preparation Log entry later in the day without anything breaking. Gating stops you from skipping forward, not from correcting backward.

**Stock In:** `DRAFT` (staff attaching slip / correcting OCR / adding manual lines) → `PENDING` (staff submits — no further staff edits) → `APPROVED` (stock +, using confirmed quantities) or `REJECTED` (no stock effect, record kept for audit)

**Preparation:** logged in real-time, immediately moves raw → display stock (no approval needed — staff-level operational action); `FRESH` entries decrement RawStock per Recipe, `CARRIED_FORWARD` entries don't (see PreparationLog above)

**Daily Closing:** `DRAFT` (staff counts remains + logs wastage per product first → enters Pathao/Foodi/Foodpanda sales, which fills in `app_channel_sold` and makes Walk-in computable → enters each channel's daily discount total → enters cash/bKash/card payments, now reconcilable) → `SUBMITTED` (staff finalizes) → `LOCKED` (auto-locks if no count-flag and no payment mismatch, or owner reviews first if either is flagged). Internally gated the same way as the day overall: Remains/Wastage → Online Sell → Walk-in (view-only) → Payments, each locked until the previous is done, each still editable after.

---

## 6a. Packaging & Supplies (periodic-count tracking)

Bags and condiment packets don't fit the `Recipe` model — there's no fixed "1 bag per burger" ratio, because bag size depends on order size (envelope for a small order, large bag for a big one), and staff isn't logging which bag went with which transaction. Forcing this through `Recipe`/`PreparationLog` would require data that doesn't exist. Instead:

### PeriodicStockCheck
A running ledger of "how much is left" snapshots for `PERIODIC_COUNT` ingredients. Staff reports what they physically see, not what they think they used — counting remaining stock is more reliable than self-reporting usage, especially if some of that usage wasn't legitimate.
| Field | Type | Notes |
|---|---|---|
| id | PK | |
| outlet_id | FK → Outlet | |
| ingredient_id | FK → Ingredient | must have `tracking_mode = PERIODIC_COUNT` |
| checked_at | datetime | |
| checked_by | FK → User | |
| counted_qty | decimal | staff-entered — current quantity remaining, in the ingredient's `base_unit` |
| stock_in_since_last_check | decimal | system — sum of approved `StockInItem` quantities for this ingredient between this check and the previous one |
| consumed_since_last_check | decimal | computed: `previous_check.counted_qty + stock_in_since_last_check − counted_qty` |
| note | text, nullable | e.g. staff flags an unusual jump themselves |

**Two ways staff updates this, both just create a new row:**
1. **Full recount** — staff enters the actual number counted (most accurate, use when convenient to actually count).
2. **"Bundle finished"** — a one-tap shortcut for the common case of "I just used the last of a bundle" — subtracts the bundle's known size (from `PackDefinition.pieces_per_pack`) from the last recorded count, without requiring a full recount. Less precise than a real count, but far lower friction, so it's more likely to actually happen regularly.

### Reporting: consumption relative to sales volume, not exact per-order tracking
Since there's no per-transaction link, the honest and useful thing to report is a **ratio against sales volume**, not a precise per-order breakdown:
```
packaging_cost(period)      = Σ (consumed_since_last_check × ingredient's effective cost per base unit) for all PERIODIC_COUNT ingredients
consumption_ratio(item, period) = consumed_since_last_check(item, period) ÷ total_units_sold(period) × 100
                                  — "units of this item per 100 products sold"
```
Compare each period's `consumption_ratio` against a trailing rolling average for that same item. A ratio that jumps well above its own recent baseline (e.g. medium bags per 100 sales suddenly up 40%) is a **signal worth investigating** — could be a genuine shift in order mix, could be misuse or shrinkage. **This system can raise the flag; it can't say what caused it** — that's the honest limit of period-level data versus per-transaction data, and worth stating plainly rather than implying a precision that doesn't exist.

`packaging_cost` is reported as its own line, separate from COGS/Wastage/Shrinkage above — it's a real cost, but attributing it to specific sales the way COGS does would be fabricating precision the data doesn't support.

---

## 7. Profit & Loss (derived, not stored raw)

For a given period (day/week/month):
```
Revenue        = Σ (channel_day_net_revenue) across all channels/days
                 where channel_day_net_revenue = Σ net_amount (DailyClosingSalesLine) − DailyChannelDiscount.discount_amount
COGS           = Σ over every unit actually SOLD (DailyClosingSalesLine.quantity_sold, incl. the derived Walk-in line):
                 Σ (Recipe.quantity_per_unit × Ingredient's effective cost per base unit)
                 where Ingredient cost per base unit = active PackDefinition.cost_per_pack ÷ pieces_per_pack
                 + combo components' own COGS (via ComboComponent → the component product's own Recipe)
Gross Profit   = Revenue − COGS
Wastage Cost   = Σ over (DailyClosingStockCount.wastage_pieces + PreparationLog.wastage_pieces where source=CARRIED_FORWARD):
                 pieces × Recipe-based ingredient cost for that product (same costing as COGS)
                 — prepared product that never became a sale: burnt/dropped during the day, or leftover that
                 didn't get carried forward the next morning. Two different moments, one combined line.
Shrinkage      = Σ DayStartStockCheck.discrepancy_qty (where > 0) × ingredient's effective cost per base unit
                 — ingredient loss discovered at day-start, before anything was prepared or sold
Fixed Costs    = Σ Expense where category.cost_type = FIXED
Variable Costs = Σ Expense where category.cost_type = VARIABLE
Adhoc Costs    = Σ Expense where category.cost_type = ADHOC
Net Profit     = Gross Profit − Wastage Cost − Shrinkage − Fixed − Variable − Adhoc
```
**Three distinct loss categories, deliberately not merged:** COGS is cost of what sold. Wastage is cost of what was made but never sold (kitchen-level: burnt, or leftover discarded next morning). Shrinkage is cost of ingredients that never even made it to preparation (storage-level: spoiled, miscounted, or worse). Collapsing any two of these into one number would hide which part of the operation is actually bleeding money.
This is accrual-based (revenue counted the day it's sold, not the day the app pays out). Run a separate **settlement reconciliation report** off `ChannelSettlement` — flags any `expected_amount` vs `received_amount` mismatch per channel/period, independent of the P&L.

---

## 8. UI Conventions

Everything below is already built in `cp-five-star-full-sitemap.html` — this section is the reference for what's there and why, not a proposal.

**Terminology:** "Stock In" (not Delivery), "Preparation log" (not Fry log), "Remains" (not Counted), "Online sell" (the combined Pathao/Foodi/Foodpanda entry screen), "Ingredient" vs "Product" (received vs sellable).

**Staff mobile — gated daily flow, not free navigation.** First launch of the day shows only "▶ Start your day" (plus a de-emphasized "view yesterday's summary" link). That leads through a short mandatory wizard — Day-Start Stock (confirm/replicate ingredient `RawStock`, any shortfall requires a `discrepancy_reason`) → Preparation Carry-Forward (move yesterday's `remains_pieces` into today's stock, partial moves auto-fill wastage) — before the bottom tab bar (Home / Stock In / Prep log / Closing) unlocks. Locked tabs show a 🔒 and refuse navigation with a nudge back to Home. Completed steps stay editable afterward (e.g. "Edit day-start stock" link on the active Home screen).

**Closing is itself a smaller gated hub**, same pattern: Count remains & wastage → Online sell → Walk-in (view-only, derived) → Payments. Each step shown as a status card; future steps show 🔒 and "Finish step N first" until unlocked in order.

**Large lists (23+ menu items) use search + category filter chips + a compact grid**, not a giant form — this is the pattern for both the Count screen and Online Sell, chosen specifically because scrolling 23 blank rows doesn't scale. Rows visually mark themselves done (light green) as filled in.

**Setup flow (owner, mostly desktop but mirrored on mobile) is four separate screens, deliberately not one:** Extract Ingredients (bulk slip upload → de-duplicated ingredient list, clean names + `base_unit` + `pieces_per_pack` captured here, once) → Import Menu (bulk product import) → Map Recipes (drag-and-drop / tap-to-assign, **plain ingredient names only, no quantity, no unit shown** — pure fast bulk association) → Edit Recipe (per-product, reached from Products & packs, where `quantity_per_unit` is actually set via always-editable number fields). Association and quantity-setting are different rhythms and were deliberately not merged onto one screen.

**Owner needs both mobile and desktop** for every feature — don't design desktop-only. Desktop sidebar is a **collapsible accordion**: Dashboard is a plain top-level link; Approvals/Reports/Manage/Setup are clickable parent headers (chevron rotates) that start collapsed and reveal their items on click.

**Packaging & Supplies staff screen** uses a stage-then-confirm pattern for the quick "− 1 bundle" action specifically (a single accidental tap shouldn't change recorded stock) — it shows a pending banner with explicit Confirm/Cancel rather than committing immediately. "Recount" (type an exact number + Save) was already a deliberate two-step action and didn't need the extra layer.

**Visual language:** ticket/receipt-style cards (dashed border, torn-edge notches) for anything resembling a physical slip or daily summary; rotated ink-stamp badges for status (`Draft`/`Pending`/`Approved`/`Rejected`/`Variance`); monospace font for all figures/quantities. Brand colors sampled from the real CP Five Star logo, not guessed: brick-red chrome (`#7A2420`) for headers/nav; bright red (`#DE2E27`) reserved for the logo mark only, never buttons (reads as alarm/danger); gold (`#F0C419`) for the wordmark and pending/prep states; near-black (`#241512`) + gold text for primary action buttons (deliberately not red, so it doesn't compete with reject/danger actions); green for approved; rust-orange for variance/flags.

**Anomaly flags never silently pass.** This shows up repeatedly by design, not by accident: impossible Walk-in (negative derived value), day-start discrepancy without a reason, unresolved Stock In ingredient, missing pack yield, packaging consumption spike — every one of these blocks progress or visibly flags rather than quietly accepting a number that doesn't add up.

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
11. **Stock and recipes moved to ingredient level** — `Ingredient` is now what's actually received/stocked (`RawStock`, `PackDefinition` both moved here from `Product`). `SupplierProductAlias` handles supplier naming mismatches with a self-improving map (unrecognized text gets resolved once by staff, remembered after that). `Recipe` links each sellable `Product` to the ingredient(s) it's made from, with `quantity_per_unit` supporting fractional consumption (e.g. mayo, 1 bottle ≈ 22 burgers) — entered as a "yield" in the UI rather than a raw fraction. COGS and ingredient-level `RawStock` deduction both now flow through `Recipe` instead of assuming a product has its own pack.
12. **Whole staff day is now gated, not just Closing** — `OperatingDay` ties Start Day → Day-Start Stock confirmation → Preparation Carry-Forward → free use of Stock In/Prep/Closing → Closing locked, into one enforced sequence. Staff can't skip ahead, but every completed step stays editable — this was an explicit requirement, not just internal consistency.
13. **Day-start stock shortfalls are quantified and categorized, not a free-text afterthought** — `DayStartStockCheck.discrepancy_qty` is computed, and any non-zero discrepancy requires a `discrepancy_reason` (spoiled / miscounted yesterday / surplus found / other) before that step counts as done. Kept deliberately separate from `DailyClosingStockCount.wastage_pieces` — one is raw-ingredient loss found before prep starts, the other is finished-product loss during the day, and collapsing them together would hide which part of the operation is actually losing money. Feeds a dedicated `Shrinkage` line in the P&L, not folded into COGS.
14. **Partial carry-forward is supported, shortfall becomes wastage automatically** — staff isn't forced to move 100% of yesterday's leftover; `PreparationLog.pieces_prepared` (the quantity actually moved) can be less than `leftover_available_pieces`, and the difference auto-fills `wastage_pieces` rather than just disappearing from the count. This combines with same-day closing wastage into one `Wastage Cost` P&L line, both costed the same way via Recipe. COGS was redefined to be based on units actually sold (not "sold/prepared") so this split is clean — COGS / Wastage / Shrinkage are now three distinct, separately-reportable loss categories instead of two blended ones.
15. **Pack yield ("how many pieces per pack") is gated at Stock In, not just set once during onboarding** — a slip only ever says "1 pack," never the piece count, so that has to live on the ingredient (`PackDefinition`) and be enforced the moment it's actually needed. A `PACK`-unit line can't move a `StockInRecord` to `PENDING` until its ingredient has a known `pieces_per_pack` — same blocking pattern as an unresolved ingredient alias. This also means the very first time an ingredient is ever received, Stock In itself is a valid (and probably the most natural) place to define its pack yield, not just the setup wizard.
16. **Map Recipes doesn't think in packs at all anymore** — superseding the previous fix (which still asked "1 pack makes how many units?"): the real simplification is choosing the right `base_unit` per ingredient at Extract Ingredients. Redefine mayo's unit from "bottle" to "portion" (1 bottle = 22 portions, captured once in `PackDefinition`), and its recipe line becomes "1 portion" — a plain whole number, same as bun and patty. Also caught and fixed a modeling mistake this exposed: "4 chicken balls need 1 bamboo stick" isn't a fraction (0.25/unit) — it only looked that way because the *product* was being mis-identified as "1 ball" instead of "1 order of Chicken Ball (4pc)." Once the product is right, it's a clean 4-per-order and 1-per-order.
17. **Map Recipes dropped quantity entry entirely — split into association vs. refinement** — even a single flat "how many?" question was still friction on a screen meant for fast bulk work. Dragging now just assigns (defaults to `quantity_per_unit = 1`), full stop. Actual quantities are set on a separate per-product **Edit Recipe** screen (reached from Products & packs), where number fields are always directly editable with no click-to-open step — the right screen for a slower, more deliberate task.
18. **Packaging/supplies (bags, condiment packets) get a separate tracking mechanism, not forced through Recipe** — `Ingredient.tracking_mode = PERIODIC_COUNT` plus `PeriodicStockCheck` (staff reports what's left, not what was used) replaces per-transaction deduction that isn't actually happening. Reporting leans on `consumption_ratio` (usage per 100 units sold) versus its own trailing baseline, flagged when it spikes — explicitly a signal to investigate, not proof of misuse, since period-level data can't attribute a spike to a specific transaction the way COGS can for recipe-linked ingredients.
19. **Owner desktop sidebar is a collapsible accordion** — Dashboard stays a plain top-level link; Approvals/Reports/Manage/Setup are collapsed by default and expand on click. Pure UI polish, no data model impact, but noted here since it changes how every owner desktop screen is reached.
