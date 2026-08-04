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
from income.models import OtherIncome
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
    other_incomes = OtherIncome.objects.filter(date__gte=start, date__lte=end)
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
        discounts = discounts.filter(daily_closing__outlet_id=outlet)
        expenses = expenses.filter(outlet_id=outlet)
        other_incomes = other_incomes.filter(outlet_id=outlet)

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
    other_income_total = sum((i.amount for i in other_incomes), Decimal("0"))
    net_profit = (
        gross_profit
        - wastage
        - shrinkage
        - sum(by_type.values(), Decimal("0"))
        + other_income_total
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
        "other_income": other_income_total,
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
def product_performance(request):
    """Per-product: units sold, gross revenue, net revenue, recipe COGS, gross profit, margin %.
    ?start=&end=&outlet="""
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start,
        daily_closing__closing_date__lte=end,
    ).select_related("product", "product__recipes__ingredient")
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)

    cost_cache = {}
    per_product = {}
    for line in lines:
        pid = line.product_id
        if pid not in per_product:
            per_product[pid] = {
                "product_id": pid,
                "product_name": line.product.name,
                "category": line.product.category,
                "units_sold": 0,
                "gross_revenue": Decimal("0"),
                "net_revenue": Decimal("0"),
                "cogs": Decimal("0"),
            }
        p = per_product[pid]
        p["units_sold"] += line.quantity_sold
        p["gross_revenue"] += line.gross_amount
        p["net_revenue"] += line.net_amount
        unit_cost = _product_unit_cost(line.product, cost_cache)
        p["cogs"] += unit_cost * line.quantity_sold

    rows = []
    for p in sorted(per_product.values(), key=lambda x: -x["net_revenue"]):
        gross_profit = p["net_revenue"] - p["cogs"]
        margin = (gross_profit / p["net_revenue"] * 100) if p["net_revenue"] else Decimal("0")
        rows.append({
            "product_id": p["product_id"],
            "product_name": p["product_name"],
            "category": p["category"],
            "units_sold": p["units_sold"],
            "gross_revenue": p["gross_revenue"].quantize(Decimal("0.01")),
            "net_revenue": p["net_revenue"].quantize(Decimal("0.01")),
            "cogs": p["cogs"].quantize(Decimal("0.01")),
            "gross_profit": gross_profit.quantize(Decimal("0.01")),
            "margin_pct": margin.quantize(Decimal("0.1")),
        })

    return Response({"start": start, "end": end, "rows": rows})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def channel_breakdown(request):
    """Revenue by sales channel: qty, gross, commission, net. ?start=&end=&outlet="""
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start,
        daily_closing__closing_date__lte=end,
    ).select_related("channel")
    discounts = DailyChannelDiscount.objects.filter(
        daily_closing__closing_date__gte=start,
        daily_closing__closing_date__lte=end,
    ).select_related("channel")
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
        discounts = discounts.filter(daily_closing__outlet_id=outlet)

    per_channel = {}
    for line in lines:
        cid = line.channel_id
        if cid not in per_channel:
            per_channel[cid] = {
                "channel_id": cid,
                "channel_name": line.channel.name,
                "units_sold": 0,
                "gross_revenue": Decimal("0"),
                "commission": Decimal("0"),
                "discount": Decimal("0"),
                "net_revenue": Decimal("0"),
            }
        c = per_channel[cid]
        c["units_sold"] += line.quantity_sold
        c["gross_revenue"] += line.gross_amount
        c["commission"] += line.commission_amount
        c["net_revenue"] += line.net_amount

    for d in discounts:
        cid = d.channel_id
        if cid in per_channel:
            per_channel[cid]["discount"] += d.discount_amount

    rows = []
    for c in sorted(per_channel.values(), key=lambda x: -x["net_revenue"]):
        rows.append({
            "channel_id": c["channel_id"],
            "channel_name": c["channel_name"],
            "units_sold": c["units_sold"],
            "gross_revenue": c["gross_revenue"].quantize(Decimal("0.01")),
            "commission": c["commission"].quantize(Decimal("0.01")),
            "discount": c["discount"].quantize(Decimal("0.01")),
            "net_revenue": (c["net_revenue"] - c["discount"]).quantize(Decimal("0.01")),
        })

    return Response({"start": start, "end": end, "rows": rows})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def stock_value(request):
    """Current raw stock on hand valued at latest ingredient cost. ?outlet="""
    from stock.models import RawStock
    outlet = request.query_params.get("outlet")

    qs = RawStock.objects.select_related("ingredient").filter(quantity_available__gt=0)
    if outlet:
        qs = qs.filter(outlet_id=outlet)

    total = Decimal("0")
    rows = []
    for rs in qs:
        pack = rs.ingredient.active_pack()
        if not pack or not pack.pieces_per_pack:
            continue
        cpu = pack.cost_per_pack / pack.pieces_per_pack
        value = rs.quantity_available * cpu
        total += value
        alias = rs.ingredient.aliases.filter(is_active=True).first()
        rows.append({
            "ingredient_id": rs.ingredient_id,
            "ingredient_name": rs.ingredient.name,
            "display_name": alias.alias_text if alias else rs.ingredient.name,
            "group": rs.ingredient.group,
            "quantity": rs.quantity_available,
            "base_unit": rs.ingredient.base_unit,
            "cost_per_unit": cpu.quantize(Decimal("0.0001")),
            "value": value.quantize(Decimal("0.01")),
        })

    rows.sort(key=lambda x: -float(x["value"]))
    return Response({"total_value": total.quantize(Decimal("0.01")), "rows": rows})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def daily_trend(request):
    """Day-by-day revenue and gross profit for a period. ?start=&end=&outlet="""
    from django.db.models import Sum
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start,
        daily_closing__closing_date__lte=end,
    )
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)

    by_date = {}
    for line in lines.select_related("product", "daily_closing"):
        d = str(line.daily_closing.closing_date)
        if d not in by_date:
            by_date[d] = {"date": d, "units_sold": 0, "revenue": Decimal("0")}
        by_date[d]["units_sold"] += line.quantity_sold
        by_date[d]["revenue"] += line.net_amount

    rows = [{"date": k, "units_sold": v["units_sold"],
             "revenue": v["revenue"].quantize(Decimal("0.01"))}
            for k, v in sorted(by_date.items())]

    return Response({"start": start, "end": end, "rows": rows})


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
