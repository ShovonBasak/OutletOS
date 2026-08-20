"""Stock/preparation/operating-day derivation logic.

Central rule of the updated model: raw stock is tracked per **Ingredient**, and
preparing a Product fans consumption out across its Recipe. COGS and RawStock
deduction both flow through Recipe rather than assuming a product has its own pack.
"""
from datetime import timedelta
from decimal import Decimal

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
