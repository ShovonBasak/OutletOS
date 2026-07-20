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
    """Walk the product's Recipe and decrement RawStock per ingredient by
    pieces × quantity_per_unit. Used by FRESH preparation entries."""
    for row in product.recipes.select_related("ingredient"):
        delta = Decimal(pieces) * row.quantity_per_unit
        RawStock.adjust(outlet, row.ingredient, -delta)


def restock_from_preparation(outlet, product, pieces):
    """Inverse of consume_for_preparation — used when a FRESH prep entry is
    deleted/reversed so raw stock is credited back."""
    for row in product.recipes.select_related("ingredient"):
        delta = Decimal(pieces) * row.quantity_per_unit
        RawStock.adjust(outlet, row.ingredient, delta)


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
            remains_pieces__gt=0
        )
    )


# ---------------------------------------------------------------------------
# Periodic stock (packaging & supplies)
# ---------------------------------------------------------------------------
def stock_in_since(outlet, ingredient, since_dt):
    """Sum of approved stock-in base-unit quantities for an ingredient since a
    given datetime — used to attribute consumption between periodic counts."""
    items = StockInItem.objects.filter(
        stock_in_record__outlet=outlet,
        ingredient=ingredient,
        stock_in_record__status=StockInStatus.APPROVED,
        stock_in_record__reviewed_at__gte=since_dt,
    ).select_related("pack_definition")
    total = Decimal("0")
    for item in items:
        total += item.base_unit_quantity()
    return total
