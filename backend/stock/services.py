"""Stock/preparation/operating-day derivation logic.

Central rule of the updated model: raw stock is tracked per **Ingredient**, and
preparing a Product fans consumption out across its Recipe. COGS and RawStock
deduction both flow through Recipe rather than assuming a product has its own pack.
"""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone

from catalog.models import TrackingMode
from .models import (
    DisplayStock,
    OperatingDay,
    OperatingDayStatus,
    PrepSource,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInStatus,
    UnitCaptured,
)


def consume_for_preparation(outlet, product, pieces):
    """Deduct all inputs needed to prepare `pieces` units of `product`:
    - Raw ingredients (Recipe rows, RECIPE_LINKED only) → deducted from RawStock
    - Prepared product components (RecipeProductComponent rows) → deducted from DisplayStock
    """
    for row in product.recipes.select_related("ingredient"):
        if row.ingredient.tracking_mode == TrackingMode.PERIODIC_COUNT:
            continue  # tracked via periodic checks, not RawStock
        delta = Decimal(pieces) * row.quantity_per_unit
        RawStock.adjust(outlet, row.ingredient, -delta)
    for row in product.product_recipe_components.select_related("component_product"):
        qty = int(Decimal(pieces) * row.quantity_per_unit)
        DisplayStock.adjust(outlet, row.component_product, -qty)


def restock_from_preparation(outlet, product, pieces):
    """Inverse of consume_for_preparation — credits back both raw and prepared inputs."""
    for row in product.recipes.select_related("ingredient"):
        if row.ingredient.tracking_mode == TrackingMode.PERIODIC_COUNT:
            continue
        delta = Decimal(pieces) * row.quantity_per_unit
        RawStock.adjust(outlet, row.ingredient, delta)
    for row in product.product_recipe_components.select_related("component_product"):
        qty = int(Decimal(pieces) * row.quantity_per_unit)
        DisplayStock.adjust(outlet, row.component_product, qty)


# ---------------------------------------------------------------------------
# Operating day
# ---------------------------------------------------------------------------
def get_or_create_today(outlet, on_date=None):
    on_date = on_date or timezone.localdate()
    day, _ = OperatingDay.objects.get_or_create(outlet=outlet, date=on_date)
    return day


def previous_operating_day(outlet, on_date):
    return (
        OperatingDay.objects.filter(outlet=outlet, date__lt=on_date)
        .order_by("-date")
        .first()
    )


def carry_forward_candidates(operating_day):
    """Yesterday's closing stock counts with remains_pieces > 0 — the products
    the carry-forward step should surface for this operating day."""
    prev = previous_operating_day(operating_day.outlet, operating_day.date)
    if not prev or not prev.daily_closing_id:
        return []
    return list(
        prev.daily_closing.stock_counts.select_related("product").filter(
            remains_pieces__gt=0,
            product__requires_preparation=True,
        )
    )


# ---------------------------------------------------------------------------
# Periodic stock (packaging & supplies)
# ---------------------------------------------------------------------------
def stock_in_since(outlet, ingredient, since_dt=None):
    """Sum of approved stock-in base-unit quantities for an ingredient since a
    given datetime. Pass since_dt=None to sum all approved stock-in ever."""
    items = StockInItem.objects.filter(
        stock_in_record__outlet=outlet,
        ingredient=ingredient,
        stock_in_record__status=StockInStatus.APPROVED,
    ).select_related("pack_definition")
    if since_dt is not None:
        items = items.filter(stock_in_record__reviewed_at__gte=since_dt)
    total = Decimal("0")
    for item in items:
        total += item.base_unit_quantity()
    return total


# ---------------------------------------------------------------------------
# Extraction post-processing
# ---------------------------------------------------------------------------
def merge_duplicate_stock_in_lines(items: list[dict]) -> tuple[list[dict], list[str]]:
    """Merge slip-extracted line items that resolve to the same catalog
    ingredient + unit within one slip's extraction result.

    A single invoice showing the same ingredient twice is almost always an
    OCR/table-parsing artifact (the same printed row read twice, or a
    multi-page slip double-extracted) rather than two genuinely separate
    deliveries — so these are summed into one line rather than kept as two,
    which would otherwise double-count the delivery when approved.

    Only merges items with a confident `matched_ingredient` — unresolved
    ("Unrecognized") lines are never merged, since each may be a genuinely
    distinct product independently needing staff attention.

    Operates on the raw extraction dicts (before ingredient_id resolution),
    the shape returned by ai_extraction.extract_historic_stock_in — so it can
    run once, right after extraction, ahead of either call site's own
    ingredient-resolution step.

    Returns (deduped_items, warnings).
    """
    AMOUNT_KEYS = ("quantity", "total_amount", "sd_amount", "vat_amount", "line_total", "discount")
    RATE_KEYS = ("rate", "sd_rate", "vat_rate")

    merged: dict = {}
    order: list = []
    warnings: list[str] = []
    next_unresolved_key = 0

    for item in items:
        name = (item.get("matched_ingredient") or "").strip().lower()
        if not name:
            key = ("__unresolved__", next_unresolved_key)
            next_unresolved_key += 1
            merged[key] = item
            order.append(key)
            continue

        unit = (item.get("unit") or "PACK").strip().upper()
        key = (name, unit)
        if key not in merged:
            merged[key] = dict(item)
            order.append(key)
        else:
            existing = merged[key]
            for k in AMOUNT_KEYS:
                a, b = existing.get(k), item.get(k)
                if a is not None or b is not None:
                    existing[k] = (a or 0) + (b or 0)
            for k in RATE_KEYS:
                if existing.get(k) is None:
                    existing[k] = item.get(k)
            existing["raw_text"] = " + ".join(
                t for t in (existing.get("raw_text", ""), item.get("raw_text", "")) if t
            )
            warnings.append(
                f"Merged {existing.get('matched_ingredient')!r} ({unit}) — appeared twice "
                f"on this slip, treated as one OCR-duplicated row rather than two deliveries."
            )

    return [merged[k] for k in order], warnings


# ---------------------------------------------------------------------------
# Backdated stock-in reconciliation
# ---------------------------------------------------------------------------
def _stock_in_on(outlet, day, ingredient_id) -> Decimal:
    """Sum of approved stock-in base units for one ingredient dated exactly `day`."""
    total = Decimal("0")
    items = StockInItem.objects.filter(
        stock_in_record__outlet=outlet,
        stock_in_record__stock_in_date=day,
        stock_in_record__status=StockInStatus.APPROVED,
        ingredient_id=ingredient_id,
    ).select_related("pack_definition")
    for item in items:
        total += item.base_unit_quantity()
    return total


def _consumption_on(outlet, day, ingredient_id) -> Decimal:
    """Ingredient consumption on `day` — prep for prepped products, sales for
    products sold with no prep step. Mirrors reports.views._do_rebuild so the
    two stay consistent with each other."""
    from catalog.models import Product
    from closing.models import DailyClosingSalesLine

    total = Decimal("0")
    prepped_pids = set()
    for log in PreparationLog.objects.filter(
        outlet=outlet, source=PrepSource.FRESH,
    ).filter(
        Q(op_date=day) | Q(op_date__isnull=True, timestamp__date=day)
    ).prefetch_related("product__recipes__ingredient"):
        prepped_pids.add(log.product_id)
        for r in log.product.recipes.all():
            if r.ingredient_id == ingredient_id:
                total += Decimal(str(log.pieces_prepared)) * r.quantity_per_unit

    sales_today = defaultdict(int)
    for row in DailyClosingSalesLine.objects.filter(
        daily_closing__outlet_id=outlet.id, daily_closing__closing_date=day
    ).values("product_id", "quantity_sold"):
        sales_today[row["product_id"]] += row["quantity_sold"]

    for pid, qty in sales_today.items():
        if pid in prepped_pids:
            continue
        prod = Product.objects.get(pk=pid)
        for r in prod.recipes.all():
            if r.ingredient_id == ingredient_id:
                total += Decimal(str(qty)) * r.quantity_per_unit
    return total


def _refresh_non_prep_closing(day, ingredient_ids, day_open) -> list[str]:
    """Recompute available_pieces/flag (and the SYSTEM_DERIVED walk-in line) for
    non-prep products on `day`'s closing, using the corrected opening balance.
    remains_pieces (a staff physical count) is never touched. LOCKED closings
    are left alone — flagged for manual review instead of silently rewriting
    finalized accounting history."""
    from closing.models import ClosingStatus, DailyClosingSalesLine, LineSource
    from sales.models import SalesChannel
    from sales.pricing import resolve_price

    warnings = []
    daily_closing = day.daily_closing
    if not daily_closing:
        return warnings

    if daily_closing.status == ClosingStatus.LOCKED:
        touches = daily_closing.stock_counts.filter(
            product__requires_preparation=False,
            product__recipes__ingredient_id__in=ingredient_ids,
        ).exists()
        if touches:
            warnings.append(
                f"{day.date}'s closing is LOCKED and may need review — its "
                f"available_pieces may now be understated. Re-run with "
                f"`fix_late_slip_day_start --date {day.date} --apply` after checking."
            )
        return warnings

    walk_in = SalesChannel.objects.filter(name__iexact="Walk-in").first()
    day_stock_in = {iid: _stock_in_on(day.outlet, day.date, iid) for iid in ingredient_ids}

    for sc in daily_closing.stock_counts.select_related("product").filter(
        product__requires_preparation=False
    ):
        product = sc.product
        recipes = [
            r for r in product.recipes.select_related("ingredient").all()
            if r.ingredient_id in ingredient_ids
        ]
        if not recipes:
            continue

        pieces_options = []
        for recipe in recipes:
            qty_per = recipe.quantity_per_unit or Decimal("1")
            open_pieces = int(day_open[recipe.ingredient_id] / qty_per)
            stock_in_pieces = int(day_stock_in[recipe.ingredient_id] / qty_per)
            pieces_options.append(open_pieces + stock_in_pieces)
        correct_available = min(pieces_options)
        if correct_available == sc.available_pieces:
            continue

        new_walkin = correct_available - sc.wastage_pieces - sc.remains_pieces - sc.app_channel_sold
        sc.available_pieces = correct_available
        sc.flag = new_walkin < 0
        sc.save(update_fields=["available_pieces", "flag"])

        if walk_in:
            old_line = DailyClosingSalesLine.objects.filter(
                daily_closing=daily_closing, product=product, channel=walk_in,
                source=LineSource.SYSTEM_DERIVED,
            ).first()
            if new_walkin > 0:
                price, _ = resolve_price(product, walk_in, day.date)
                if old_line:
                    old_line.quantity_sold = new_walkin
                    old_line.unit_price = price
                    old_line.gross_amount = price * new_walkin
                    old_line.net_amount = old_line.gross_amount
                    old_line.save(update_fields=[
                        "quantity_sold", "unit_price", "gross_amount", "net_amount"
                    ])
                else:
                    line = DailyClosingSalesLine(
                        daily_closing=daily_closing, product=product, channel=walk_in,
                        quantity_sold=new_walkin, unit_price=price,
                        source=LineSource.SYSTEM_DERIVED,
                    )
                    line.recompute()
                    line.save()
            elif old_line:
                old_line.delete()

    return warnings


def reconcile_backdated_stock_in(record) -> list[str]:
    """Call right after a StockInRecord becomes APPROVED. A no-op unless
    `record.stock_in_date` is earlier than some OperatingDay whose Day-Start
    Stock Check is already confirmed — the "late slip" pattern (dated for a
    day that's already closed out, but approved afterward, once the delivery
    it represents was already physically on hand for every day since).

    When that's the case, this cascades an ABSOLUTE recompute — never additive
    — of every affected day's DayStartStockCheck (system_carried_qty =
    confirmed_qty = the ledger-derived true opening, no discrepancy flagged:
    there's nothing to reconcile, this is what the system should have shown),
    RawStock, and non-prep closing counts for any still-open DailyClosing along
    the way. LOCKED closings are left untouched but flagged.

    Every value is derived fresh from the ledger (approved StockInItem rows +
    PreparationLog + DailyClosingSalesLine) each call, so this is safe to call
    unconditionally after every approval, and safe to call more than once for
    the same record — it can't double-count the way an additive fix would.

    Returns a list of human-readable warnings (empty in the ordinary case).
    """
    outlet = record.outlet
    stock_in_date = record.stock_in_date

    affected_ingredient_ids = list(
        record.items.filter(ingredient__isnull=False)
        .exclude(ingredient__tracking_mode=TrackingMode.PERIODIC_COUNT)
        .values_list("ingredient_id", flat=True)
        .distinct()
    )
    if not affected_ingredient_ids:
        return []

    later_days = list(
        OperatingDay.objects.filter(
            outlet=outlet, date__gt=stock_in_date, stock_confirmed_at__isnull=False,
        ).order_by("date")
    )
    if not later_days:
        return []  # ordinary case: nothing confirmed yet after this slip's date

    from .models import DayStartStockCheck

    anchor_day = OperatingDay.objects.filter(outlet=outlet, date=stock_in_date).first()
    anchor_checks = {}
    if anchor_day:
        anchor_checks = {
            c.ingredient_id: c
            for c in DayStartStockCheck.objects.filter(
                operating_day=anchor_day, ingredient_id__in=affected_ingredient_ids,
            )
        }

    running: dict[int, Decimal] = {}
    for iid in affected_ingredient_ids:
        opening = anchor_checks[iid].confirmed_qty if iid in anchor_checks else Decimal("0")
        running[iid] = (
            opening + _stock_in_on(outlet, stock_in_date, iid) - _consumption_on(outlet, stock_in_date, iid)
        )

    warnings: list[str] = []
    for day in later_days:
        day_open = dict(running)
        for iid in affected_ingredient_ids:
            check = DayStartStockCheck.objects.filter(operating_day=day, ingredient_id=iid).first()
            if check:
                check.system_carried_qty = day_open[iid]
                check.confirmed_qty = day_open[iid]
                check.discrepancy_reason = ""
                check.note = ""
                check.save(update_fields=[
                    "system_carried_qty", "confirmed_qty", "discrepancy_reason", "note"
                ])
            running[iid] += _stock_in_on(outlet, day.date, iid) - _consumption_on(outlet, day.date, iid)

        warnings += _refresh_non_prep_closing(day, affected_ingredient_ids, day_open)

    from catalog.models import Ingredient
    for iid, qty in running.items():
        RawStock.set_to(outlet, Ingredient.objects.get(pk=iid), qty)

    return warnings
