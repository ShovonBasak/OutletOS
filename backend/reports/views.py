"""Derived P&L, settlement variance, packaging, and dashboard reports.

Three distinct loss categories are kept separate, per the data model:
  COGS       — recipe cost of what was actually SOLD
  Wastage    — recipe cost of what was made but never sold (kitchen level)
  Shrinkage  — ingredient cost lost before prep (day-start storage level)
Packaging (periodic-count supplies) is reported as its own line as well.
"""
from decimal import Decimal

from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from catalog.models import ProductType
from closing.models import (
    ChannelSettlement,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
)
from costs.models import CostType, Expense
from stock.models import (
    DayStartStockCheck,
    PeriodicStockCheck,
    PrepSource,
    PreparationLog,
    StockInRecord,
    StockInStatus,
)


def _default_range(request):
    today = timezone.localdate()
    start = request.query_params.get("start", today.replace(day=1).isoformat())
    end = request.query_params.get("end", today.isoformat())
    return start, end


# ---------------------------------------------------------------------------
# Recipe-based costing
# ---------------------------------------------------------------------------
def _product_unit_cost(product, cache):
    """Cost to make one unit of a product = Σ recipe qty × ingredient cost per
    base unit. Combos expand through their component products' own recipes."""
    if product.id in cache:
        return cache[product.id]
    total = Decimal("0")
    if product.product_type == ProductType.COMBO:
        for comp in product.components.select_related("component_product"):
            total += _product_unit_cost(comp.component_product, cache) * comp.quantity_per_combo
    else:
        for row in product.recipes.select_related("ingredient"):
            total += row.quantity_per_unit * row.ingredient.cost_per_base_unit
    cache[product.id] = total
    return total


def _cogs(outlet, start, end, cost_cache):
    """Σ over every unit actually SOLD: recipe cost."""
    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    ).select_related("product")
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
    total = Decimal("0")
    for line in lines:
        total += _product_unit_cost(line.product, cost_cache) * line.quantity_sold
    return total


def _wastage_cost(outlet, start, end, cost_cache):
    """Prepared product that never became a sale: closing wastage + carry-forward
    leftover that wasn't moved the next morning."""
    total = Decimal("0")
    counts = DailyClosingStockCount.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    ).select_related("product")
    if outlet:
        counts = counts.filter(daily_closing__outlet_id=outlet)
    for c in counts:
        if c.wastage_pieces:
            total += _product_unit_cost(c.product, cost_cache) * c.wastage_pieces

    carried = PreparationLog.objects.filter(
        source=PrepSource.CARRIED_FORWARD,
        timestamp__date__gte=start, timestamp__date__lte=end,
    ).select_related("product")
    if outlet:
        carried = carried.filter(outlet_id=outlet)
    for log in carried:
        if log.wastage_pieces:
            total += _product_unit_cost(log.product, cost_cache) * log.wastage_pieces
    return total


def _shrinkage_cost(outlet, start, end):
    """Ingredient loss found at day-start, before anything was prepared/sold."""
    checks = DayStartStockCheck.objects.filter(
        operating_day__date__gte=start, operating_day__date__lte=end
    ).select_related("ingredient")
    if outlet:
        checks = checks.filter(operating_day__outlet_id=outlet)
    total = Decimal("0")
    for chk in checks:
        shortfall = chk.discrepancy_qty
        if shortfall > 0:  # shortfalls only; a surplus flags a counting problem
            total += shortfall * chk.ingredient.cost_per_base_unit
    return total


def _packaging_cost(outlet, start, end):
    checks = PeriodicStockCheck.objects.filter(
        checked_at__date__gte=start, checked_at__date__lte=end
    ).select_related("ingredient")
    if outlet:
        checks = checks.filter(outlet_id=outlet)
    total = Decimal("0")
    for chk in checks:
        if chk.consumed_since_last_check > 0:
            total += chk.consumed_since_last_check * chk.ingredient.cost_per_base_unit
    return total


def compute_pnl(start, end, outlet=None):
    cost_cache = {}
    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    )
    discounts = DailyChannelDiscount.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    )
    expenses = Expense.objects.filter(date__gte=start, date__lte=end).select_related("category")
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
        discounts = discounts.filter(daily_closing__outlet_id=outlet)
        expenses = expenses.filter(outlet_id=outlet)

    gross_net = sum((l.net_amount for l in lines), Decimal("0"))
    discount_total = sum((d.discount_amount for d in discounts), Decimal("0"))
    revenue = gross_net - discount_total
    cogs = _cogs(outlet, start, end, cost_cache)
    gross_profit = revenue - cogs
    wastage = _wastage_cost(outlet, start, end, cost_cache)
    shrinkage = _shrinkage_cost(outlet, start, end)
    packaging = _packaging_cost(outlet, start, end)

    by_type = {
        CostType.FIXED: Decimal("0"),
        CostType.VARIABLE: Decimal("0"),
        CostType.ADHOC: Decimal("0"),
    }
    for exp in expenses:
        by_type[exp.category.cost_type] += exp.amount
    net_profit = (
        gross_profit - wastage - shrinkage - sum(by_type.values(), Decimal("0"))
    )

    return {
        "start": start, "end": end,
        "revenue": revenue,
        "cogs": cogs,
        "gross_profit": gross_profit,
        "wastage_cost": wastage,
        "shrinkage_cost": shrinkage,
        "packaging_cost": packaging,
        "fixed_costs": by_type[CostType.FIXED],
        "variable_costs": by_type[CostType.VARIABLE],
        "adhoc_costs": by_type[CostType.ADHOC],
        "net_profit": net_profit,
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def pnl_report(request):
    """?start=&end=&outlet= — accrual P&L per the data-model formulas."""
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")
    return Response(compute_pnl(start, end, outlet))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def settlement_report(request):
    """Settlement variance per channel/period for DIRECT_TO_ACCOUNT channels."""
    qs = ChannelSettlement.objects.select_related("channel")
    outlet = request.query_params.get("outlet")
    if outlet:
        qs = qs.filter(outlet_id=outlet)
    rows = []
    for s in qs:
        received = s.received_amount or Decimal("0")
        rows.append({
            "id": s.id,
            "channel": s.channel.name,
            "period_start": s.period_start,
            "period_end": s.period_end,
            "expected_amount": s.expected_amount,
            "received_amount": s.received_amount,
            "variance": received - s.expected_amount,
            "status": s.status,
            "notes": s.notes,
        })
    return Response(rows)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def packaging_report(request):
    """Consumption of PERIODIC_COUNT supplies vs sales volume for the period.

    consumption_ratio = units consumed per 100 products sold. A jump above an
    item's own trailing baseline is a signal to investigate, not proof of misuse.
    """
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    total_units_sold = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    )
    if outlet:
        total_units_sold = total_units_sold.filter(daily_closing__outlet_id=outlet)
    units_sold = sum((l.quantity_sold for l in total_units_sold), 0)

    checks = PeriodicStockCheck.objects.filter(
        checked_at__date__gte=start, checked_at__date__lte=end
    ).select_related("ingredient")
    if outlet:
        checks = checks.filter(outlet_id=outlet)

    per_ingredient = {}
    for chk in checks:
        agg = per_ingredient.setdefault(
            chk.ingredient_id,
            {"ingredient": chk.ingredient.name, "base_unit": chk.ingredient.base_unit,
             "consumed": Decimal("0"), "cost_per_base_unit": chk.ingredient.cost_per_base_unit},
        )
        if chk.consumed_since_last_check > 0:
            agg["consumed"] += chk.consumed_since_last_check

    rows = []
    for data in per_ingredient.values():
        consumed = data["consumed"]
        ratio = (
            (consumed / Decimal(units_sold) * Decimal("100")) if units_sold else Decimal("0")
        )
        rows.append({
            "ingredient": data["ingredient"],
            "base_unit": data["base_unit"],
            "consumed": consumed,
            "cost": (consumed * data["cost_per_base_unit"]).quantize(Decimal("0.01")),
            "consumption_ratio": ratio.quantize(Decimal("0.01")),
        })
    return Response({
        "start": start, "end": end,
        "total_units_sold": units_sold,
        "rows": rows,
    })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def dashboard_summary(request):
    """Owner home: today's P&L + pending review counts."""
    today = timezone.localdate()
    outlet = request.query_params.get("outlet")

    pending_stock = StockInRecord.objects.filter(status=StockInStatus.PENDING)
    awaiting = DailyClosing.objects.filter(status="SUBMITTED")
    if outlet:
        pending_stock = pending_stock.filter(outlet_id=outlet)
        awaiting = awaiting.filter(outlet_id=outlet)

    return Response({
        "date": today,
        "pnl_today": compute_pnl(today.isoformat(), today.isoformat(), outlet),
        "pending_stock_ins": pending_stock.count(),
        "closings_awaiting_review": awaiting.count(),
    })
