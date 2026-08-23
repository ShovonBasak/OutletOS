"""Derived P&L, settlement variance, packaging, and dashboard reports.

Three distinct loss categories are kept separate, per the data model:
  COGS       — recipe cost of what was actually SOLD
  Wastage    — recipe cost of what was made but never sold (kitchen level)
  Shrinkage  — ingredient cost lost before prep (day-start storage level)
Packaging (periodic-count supplies) is reported as its own line as well.
"""
from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from catalog.models import Outlet, Product, ProductType, TrackingMode
from closing.models import (
    ChannelSettlement,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    LineSource,
)
from costs.models import CostType, Expense
from income.models import OtherIncome
from sales.models import SalesChannel
from sales.pricing import resolve_price
from stock.models import (
    DayStartStockCheck,
    DisplayStock,
    OperatingDay,
    PeriodicStockCheck,
    PrepSource,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
    StockInStatus,
    UnitCaptured,
)


MAX_RANGE_DAYS = 31


def _default_range(request):
    from datetime import date, timedelta
    today = timezone.localdate()
    start = request.query_params.get("start", today.replace(day=1).isoformat())
    end = request.query_params.get("end", today.isoformat())
    return start, end


def _clamped_range(request):
    """Like _default_range but caps the range at MAX_RANGE_DAYS.

    Returns (start, end, range_clamped) where range_clamped=True signals that
    the requested range was trimmed so the frontend can show a note to the user."""
    from datetime import date as date_cls, timedelta
    start, end = _default_range(request)
    try:
        start_d = date_cls.fromisoformat(start)
        end_d = date_cls.fromisoformat(end)
    except ValueError:
        return start, end, False
    if (end_d - start_d).days > MAX_RANGE_DAYS:
        start_d = end_d - timedelta(days=MAX_RANGE_DAYS)
        return start_d.isoformat(), end, True
    return start, end, False


# ---------------------------------------------------------------------------
# Recipe-based costing
# ---------------------------------------------------------------------------

def _build_pack_history():
    """Load all PackDefinitions into memory as {ingredient_id: [(from, to, cpu), ...]}
    sorted descending by effective_from. One query; used by all cost functions so
    COGS uses the price that was active on the date of sale/wastage/shrinkage."""
    from catalog.models import PackDefinition
    rows = PackDefinition.objects.values(
        "ingredient_id", "effective_from", "effective_to",
        "cost_per_pack", "pieces_per_pack",
    ).order_by("ingredient_id", "-effective_from")
    history: dict = {}
    for r in rows:
        if not r["pieces_per_pack"]:
            continue
        cpu = (
            Decimal(str(r["cost_per_pack"])) / Decimal(str(r["pieces_per_pack"]))
        ).quantize(Decimal("0.0001"))
        history.setdefault(r["ingredient_id"], []).append(
            (r["effective_from"], r["effective_to"], cpu)
        )
    return history


def _cost_at_date(ingredient_id, on_date, pack_history):
    """Cost per base unit for an ingredient on a specific date, from the
    pre-loaded pack_history dict. Returns 0 if no matching pack found."""
    for eff_from, eff_to, cpu in pack_history.get(ingredient_id, []):
        if eff_from <= on_date and (eff_to is None or eff_to >= on_date):
            return cpu
    return Decimal("0")


def _product_unit_cost(product, cache, on_date=None, pack_history=None):
    """Cost to make one unit of a product = Σ recipe qty × ingredient cost per
    base unit. Pass on_date + pack_history for date-accurate pricing; omit both
    for a quick current-price estimate."""
    cache_key = (product.id, on_date)
    if cache_key in cache:
        return cache[cache_key]
    total = Decimal("0")
    if product.product_type == ProductType.COMBO:
        for comp in product.components.select_related("component_product"):
            total += (
                _product_unit_cost(comp.component_product, cache, on_date, pack_history)
                * comp.quantity_per_combo
            )
    else:
        for row in product.recipes.select_related("ingredient"):
            if on_date is not None and pack_history is not None:
                cost = _cost_at_date(row.ingredient_id, on_date, pack_history)
            else:
                cost = row.ingredient.cost_per_base_unit
            total += row.quantity_per_unit * cost
    cache[cache_key] = total
    return total


def _cogs(outlet, start, end, cost_cache, pack_history=None):
    """Σ over every unit actually SOLD: recipe cost at the price on the sale date."""
    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    ).select_related("product", "daily_closing")
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
    total = Decimal("0")
    for line in lines:
        sale_date = line.daily_closing.closing_date
        total += _product_unit_cost(line.product, cost_cache, on_date=sale_date, pack_history=pack_history) * line.quantity_sold
    return total


def _wastage_cost(outlet, start, end, cost_cache, pack_history=None):
    """Prepared product that never became a sale: closing wastage + carry-forward
    leftover that wasn't moved the next morning."""
    total = Decimal("0")
    counts = DailyClosingStockCount.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    ).select_related("product", "daily_closing")
    if outlet:
        counts = counts.filter(daily_closing__outlet_id=outlet)
    for c in counts:
        if c.wastage_pieces:
            waste_date = c.daily_closing.closing_date
            total += _product_unit_cost(c.product, cost_cache, on_date=waste_date, pack_history=pack_history) * c.wastage_pieces

    carried = PreparationLog.objects.filter(
        source=PrepSource.CARRIED_FORWARD,
        timestamp__date__gte=start, timestamp__date__lte=end,
    ).select_related("product")
    if outlet:
        carried = carried.filter(outlet_id=outlet)
    for log in carried:
        if log.wastage_pieces:
            prep_date = log.timestamp.date()
            total += _product_unit_cost(log.product, cost_cache, on_date=prep_date, pack_history=pack_history) * log.wastage_pieces
    return total


def _shrinkage_cost(outlet, start, end, pack_history=None):
    """Ingredient loss found at day-start, before anything was prepared/sold."""
    checks = DayStartStockCheck.objects.filter(
        operating_day__date__gte=start, operating_day__date__lte=end
    ).select_related("ingredient", "operating_day")
    if outlet:
        checks = checks.filter(operating_day__outlet_id=outlet)
    total = Decimal("0")
    for chk in checks:
        shortfall = chk.discrepancy_qty
        if shortfall > 0:  # shortfalls only; a surplus flags a counting problem
            if pack_history is not None:
                cpu = _cost_at_date(chk.ingredient_id, chk.operating_day.date, pack_history)
            else:
                cpu = chk.ingredient.cost_per_base_unit
            total += shortfall * cpu
    return total


def _packaging_cost(outlet, start, end, pack_history=None):
    checks = PeriodicStockCheck.objects.filter(
        checked_at__date__gte=start, checked_at__date__lte=end
    ).select_related("ingredient")
    if outlet:
        checks = checks.filter(outlet_id=outlet)
    total = Decimal("0")
    for chk in checks:
        if chk.consumed_since_last_check > 0:
            if pack_history is not None:
                cpu = _cost_at_date(chk.ingredient_id, chk.checked_at.date(), pack_history)
            else:
                cpu = chk.ingredient.cost_per_base_unit
            total += chk.consumed_since_last_check * cpu
    return total


def compute_pnl(start, end, outlet=None):
    cost_cache = {}
    pack_history = _build_pack_history()
    lines = DailyClosingSalesLine.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    )
    expenses = Expense.objects.filter(date__gte=start, date__lte=end).select_related("category")
    other_incomes = OtherIncome.objects.filter(date__gte=start, date__lte=end)
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)
        expenses = expenses.filter(outlet_id=outlet)
        other_incomes = other_incomes.filter(outlet_id=outlet)

    # Revenue = Σ net_amount (gross already reduced by commission_rate per channel).
    # DailyChannelDiscount is retained for reconciliation but not deducted from P&L.
    revenue = sum((l.net_amount for l in lines), Decimal("0"))
    cogs = _cogs(outlet, start, end, cost_cache, pack_history)
    gross_profit = revenue - cogs
    wastage = _wastage_cost(outlet, start, end, cost_cache, pack_history)
    shrinkage = _shrinkage_cost(outlet, start, end, pack_history)
    packaging = _packaging_cost(outlet, start, end, pack_history)

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
        - packaging
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
    ?start=&end=&outlet= (range capped at MAX_RANGE_DAYS)"""
    start, end, range_clamped = _clamped_range(request)
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

    return Response({"start": start, "end": end, "rows": rows, "range_clamped": range_clamped})


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
            "platform_discount": c["discount"].quantize(Decimal("0.01")),
            # net_revenue = gross − commission only; platform_discount is informational
            "net_revenue": c["net_revenue"].quantize(Decimal("0.01")),
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
    """Analytics dashboard: P&L summary + daily trend with COGS + top products + channel split.
    ?start=YYYY-MM-DD&end=YYYY-MM-DD&outlet=1  (default: last 30 days)
    """
    from datetime import date as date_cls, timedelta
    outlet = request.query_params.get("outlet")
    today_d = timezone.localdate()

    end_d = date_cls.fromisoformat(request.query_params["end"]) if request.query_params.get("end") else today_d
    start_d = date_cls.fromisoformat(request.query_params["start"]) if request.query_params.get("start") else end_d - timedelta(days=29)
    start, end = start_d.isoformat(), end_d.isoformat()

    lines_qs = (
        DailyClosingSalesLine.objects.filter(
            daily_closing__closing_date__gte=start,
            daily_closing__closing_date__lte=end,
        )
        .select_related("product", "daily_closing", "channel")
    )
    if outlet:
        lines_qs = lines_qs.filter(daily_closing__outlet_id=outlet)

    cost_cache: dict = {}
    pack_history = _build_pack_history()
    by_date: dict = {}
    by_product: dict = {}
    by_channel: dict = {}

    for line in lines_qs:
        d = str(line.daily_closing.closing_date)
        sale_date = line.daily_closing.closing_date
        unit_cost = _product_unit_cost(line.product, cost_cache, on_date=sale_date, pack_history=pack_history)
        line_cogs = unit_cost * Decimal(line.quantity_sold)

        day = by_date.setdefault(d, {"date": d, "units_sold": 0, "revenue": Decimal("0"), "cogs": Decimal("0")})
        day["units_sold"] += line.quantity_sold
        day["revenue"] += line.net_amount
        day["cogs"] += line_cogs

        pid = line.product_id
        prod = by_product.setdefault(pid, {
            "product_name": line.product.name, "category": line.product.category,
            "units_sold": 0, "revenue": Decimal("0"), "cogs": Decimal("0"),
        })
        prod["units_sold"] += line.quantity_sold
        prod["revenue"] += line.net_amount
        prod["cogs"] += line_cogs

        ch_name = line.channel.name if line.channel else "Walk-in"
        ch = by_channel.setdefault(ch_name, {"channel": ch_name, "units_sold": 0, "revenue": Decimal("0"), "gross_revenue": Decimal("0")})
        ch["units_sold"] += line.quantity_sold
        ch["revenue"] += line.net_amount
        ch["gross_revenue"] += line.gross_amount

    q, q1 = Decimal("0.01"), Decimal("0.1")

    daily = [
        {"date": k, "units_sold": v["units_sold"],
         "revenue": str(v["revenue"].quantize(q)), "cogs": str(v["cogs"].quantize(q))}
        for k, v in sorted(by_date.items())
    ]

    top_products = []
    for p in sorted(by_product.values(), key=lambda x: -x["revenue"])[:10]:
        gp = p["revenue"] - p["cogs"]
        margin = (gp / p["revenue"] * 100) if p["revenue"] else Decimal("0")
        top_products.append({
            "product_name": p["product_name"], "category": p["category"],
            "units_sold": p["units_sold"],
            "revenue": str(p["revenue"].quantize(q)), "cogs": str(p["cogs"].quantize(q)),
            "gross_profit": str(gp.quantize(q)), "margin_pct": str(margin.quantize(q1)),
        })

    channels = []
    for ch, v in sorted(by_channel.items(), key=lambda x: -x[1]["revenue"]):
        channels.append({
            "channel": ch, "units_sold": v["units_sold"],
            "revenue": str(v["revenue"].quantize(q)),
            "commission": str((v["gross_revenue"] - v["revenue"]).quantize(q)),
        })

    return Response({
        "start": start, "end": end,
        "pnl": compute_pnl(start, end, outlet),
        "daily": daily,
        "top_products": top_products,
        "channels": channels,
    })


def _product_remaining_stock(product: Product, outlet_id) -> int | None:
    """Units of product that can still be made from current RawStock."""
    recipes = list(product.recipes.select_related("ingredient").all())
    if not recipes:
        return None
    minimum = None
    for r in recipes:
        rs = RawStock.objects.filter(outlet_id=outlet_id, ingredient=r.ingredient).first()
        qty = rs.quantity_available if rs else Decimal("0")
        available = int(qty / r.quantity_per_unit) if r.quantity_per_unit else int(qty)
        minimum = available if minimum is None else min(minimum, available)
    return minimum


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def sell_history(request):
    """
    Date-wise sell quantities per product.
    ?outlet=1&start=YYYY-MM-DD&end=YYYY-MM-DD (range capped at MAX_RANGE_DAYS)
    Returns { dates: [...], rows: [...], range_clamped: bool }
    """
    start, end, range_clamped = _clamped_range(request)
    outlet = request.query_params.get("outlet")

    lines = (
        DailyClosingSalesLine.objects
        .filter(
            daily_closing__closing_date__gte=start,
            daily_closing__closing_date__lte=end,
        )
        .select_related("product", "daily_closing")
        .order_by("daily_closing__closing_date")
    )
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)

    # {product_id: {date_str: qty}}
    sales: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    product_meta: dict[int, dict] = {}
    dates_set: set[str] = set()

    for line in lines:
        pid = line.product_id
        d = str(line.daily_closing.closing_date)
        sales[pid][d] += line.quantity_sold
        dates_set.add(d)
        if pid not in product_meta:
            product_meta[pid] = {
                "id": pid,
                "name": line.product.name,
                "category": line.product.category or "",
            }

    sorted_dates = sorted(dates_set)
    sorted_pids = sorted(product_meta, key=lambda p: product_meta[p]["name"])

    # Bulk-fetch products for stock calc
    products_qs = {
        p.id: p for p in
        Product.objects.prefetch_related("recipes__ingredient").filter(id__in=sorted_pids)
    }

    rows = []
    for pid in sorted_pids:
        meta = product_meta[pid]
        daily = {d: sales[pid].get(d, 0) for d in sorted_dates}
        total = sum(daily.values())
        product = products_qs.get(pid)
        stock = _product_remaining_stock(product, outlet) if product and outlet else None
        rows.append({
            "id": meta["id"],
            "name": meta["name"],
            "category": meta["category"],
            "daily": daily,
            "total": total,
            "stock": stock,
        })

    return Response({"dates": sorted_dates, "rows": rows, "range_clamped": range_clamped})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def stock_in_history(request):
    """
    Date-wise approved stock-in quantities per ingredient (in base units).
    ?outlet=1&start=YYYY-MM-DD&end=YYYY-MM-DD (range capped at MAX_RANGE_DAYS)
    Returns { dates: [...], rows: [...], range_clamped: bool }
    """
    start, end, range_clamped = _clamped_range(request)
    outlet = request.query_params.get("outlet")

    items = (
        StockInItem.objects
        .filter(
            stock_in_record__status=StockInStatus.APPROVED,
            stock_in_record__stock_in_date__gte=start,
            stock_in_record__stock_in_date__lte=end,
            ingredient__isnull=False,
        )
        .select_related(
            "ingredient",
            "pack_definition",
            "stock_in_record",
        )
        .order_by("stock_in_record__stock_in_date")
    )
    if outlet:
        items = items.filter(stock_in_record__outlet_id=outlet)

    # {ingredient_id: {date_str: qty_in_base_units}}
    received: dict[int, dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    ingredient_meta: dict[int, dict] = {}
    dates_set: set[str] = set()

    for item in items:
        iid = item.ingredient_id
        d = str(item.stock_in_record.stock_in_date)
        received[iid][d] += item.base_unit_quantity()
        dates_set.add(d)
        if iid not in ingredient_meta:
            ing = item.ingredient
            ingredient_meta[iid] = {
                "id": iid,
                "name": ing.name,
                "base_unit": ing.base_unit,
                "group": ing.group or "",
            }

    sorted_dates = sorted(dates_set)
    sorted_iids = sorted(ingredient_meta, key=lambda i: ingredient_meta[i]["name"])

    # Bulk-fetch current RawStock
    raw_stocks = {}
    if outlet:
        for rs in RawStock.objects.filter(outlet_id=outlet, ingredient_id__in=sorted_iids):
            raw_stocks[rs.ingredient_id] = rs.quantity_available

    rows = []
    for iid in sorted_iids:
        meta = ingredient_meta[iid]
        daily = {d: float(received[iid].get(d, 0)) for d in sorted_dates}
        total = sum(daily.values())
        stock = float(raw_stocks[iid]) if iid in raw_stocks else None
        rows.append({
            "id": meta["id"],
            "name": meta["name"],
            "base_unit": meta["base_unit"],
            "group": meta["group"],
            "daily": daily,
            "total": total,
            "stock": stock,
        })

    return Response({"dates": sorted_dates, "rows": rows, "range_clamped": range_clamped})


# ---------------------------------------------------------------------------
# Sell corrections
# ---------------------------------------------------------------------------

@api_view(["GET"])
@permission_classes([IsAuthenticated])
def daily_sells(request):
    """
    All active products with their total sold qty for a given day.
    ?outlet=1&date=YYYY-MM-DD
    Returns {date, rows: [{product_id, name, category, quantity_sold, app_sold}]}
    app_sold = total from non-walk-in channels (floor for corrections).
    """
    from datetime import date as date_cls
    outlet_id = request.query_params.get("outlet", "1")
    date_str = request.query_params.get("date")
    if not date_str:
        return Response({"error": "date required"}, status=400)
    try:
        target_date = date_cls.fromisoformat(date_str)
    except ValueError:
        return Response({"error": "invalid date"}, status=400)

    products = list(Product.objects.filter(is_active=True).order_by("category", "name"))

    walk_in = next(
        (ch for ch in SalesChannel.objects.all() if ch.is_walk_in), None
    )
    walk_in_id = walk_in.id if walk_in else None

    lines = (
        DailyClosingSalesLine.objects
        .filter(
            daily_closing__outlet_id=outlet_id,
            daily_closing__closing_date=target_date,
        )
        .values("product_id", "channel_id")
        .annotate(total=Sum("quantity_sold"))
    )

    total_map: dict[int, int] = defaultdict(int)
    app_map: dict[int, int] = defaultdict(int)
    for row in lines:
        pid = row["product_id"]
        total_map[pid] += row["total"]
        if row["channel_id"] != walk_in_id:
            app_map[pid] += row["total"]

    rows = [
        {
            "product_id": p.id,
            "name": p.name,
            "category": p.category or "",
            "quantity_sold": total_map.get(p.id, 0),
            "app_sold": app_map.get(p.id, 0),
        }
        for p in products
    ]
    return Response({"date": date_str, "rows": rows})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def correct_sells(request):
    """
    Correct walk-in sell quantities for a specific day.
    Body: {outlet: 1, date: "YYYY-MM-DD", corrections: [{product_id, new_qty}]}
    Adjusts walk-in DailyClosingSalesLine, syncs PrepLog, applies RawStock delta.
    """
    from datetime import date as date_cls
    outlet_id = int(request.data.get("outlet", 1))
    date_str = request.data.get("date")
    corrections = request.data.get("corrections", [])

    if not date_str:
        return Response({"error": "date required"}, status=400)
    if not corrections:
        return Response({"error": "no corrections provided"}, status=400)

    try:
        target_date = date_cls.fromisoformat(date_str)
    except ValueError:
        return Response({"error": "invalid date"}, status=400)

    try:
        outlet = Outlet.objects.get(id=outlet_id)
    except Outlet.DoesNotExist:
        return Response({"error": "outlet not found"}, status=404)

    walk_in = next(
        (ch for ch in SalesChannel.objects.all() if ch.is_walk_in), None
    )
    if not walk_in:
        return Response({"error": "Walk-in channel not configured"}, status=500)

    daily_closing = DailyClosing.objects.filter(
        outlet_id=outlet_id, closing_date=target_date
    ).first()
    if not daily_closing:
        return Response({"error": f"No closing record for {target_date}"}, status=404)

    applied = []
    errors = []

    with transaction.atomic():
        for corr in corrections:
            product_id = corr.get("product_id")
            try:
                new_total = int(corr.get("new_qty", 0))
            except (TypeError, ValueError):
                errors.append(f"Invalid qty for product {product_id}")
                continue

            if new_total < 0:
                errors.append(f"Quantity cannot be negative (product {product_id})")
                continue

            try:
                product = Product.objects.prefetch_related(
                    "recipes__ingredient"
                ).get(id=product_id)
            except Product.DoesNotExist:
                errors.append(f"Product {product_id} not found")
                continue

            all_lines = list(
                DailyClosingSalesLine.objects.filter(
                    daily_closing=daily_closing, product=product
                ).select_related("channel")
            )
            old_total = sum(l.quantity_sold for l in all_lines)
            delta = new_total - old_total
            if delta == 0:
                continue

            app_total = sum(
                l.quantity_sold for l in all_lines if not l.channel.is_walk_in
            )
            new_walkin = new_total - app_total
            if new_walkin < 0:
                errors.append(
                    f"{product.name}: new total ({new_total}) is below app sales "
                    f"({app_total}) — cannot reduce app channel sales here"
                )
                continue

            walkin_line = next((l for l in all_lines if l.channel.is_walk_in), None)
            if new_walkin == 0:
                if walkin_line:
                    walkin_line.delete()
            else:
                if walkin_line:
                    walkin_line.quantity_sold = new_walkin
                    walkin_line.save()
                else:
                    try:
                        price, _ = resolve_price(product, walk_in, target_date)
                    except Exception:
                        price = product.selling_price
                    DailyClosingSalesLine.objects.create(
                        daily_closing=daily_closing,
                        product=product,
                        channel=walk_in,
                        quantity_sold=new_walkin,
                        unit_price=price,
                        source=LineSource.SYSTEM_DERIVED,
                    )

            preplogs = PreparationLog.objects.filter(
                outlet=outlet,
                product=product,
                source=PrepSource.FRESH,
            ).filter(
                Q(op_date=target_date)
                | Q(op_date__isnull=True, timestamp__date=target_date)
            )
            if preplogs.exists():
                if new_total == 0:
                    preplogs.delete()
                else:
                    preplogs.update(pieces_prepared=new_total, wastage_pieces=0)

            for r in product.recipes.all():
                ing = r.ingredient
                if ing.tracking_mode == TrackingMode.ONE_TIME:
                    continue
                RawStock.adjust(outlet, ing, -(Decimal(str(delta)) * r.quantity_per_unit))

            applied.append({
                "product": product.name,
                "old_qty": old_total,
                "new_qty": new_total,
                "delta": delta,
            })

        if errors:
            raise ValueError("; ".join(errors))

    return Response({"ok": True, "applied": applied})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def shrinkage_detail(request):
    """Per-day, per-ingredient shrinkage breakdown for the period.

    Only shortfalls (discrepancy_qty > 0) are returned — surpluses are a
    counting anomaly and not a cost.

    ?start=&end=&outlet=
    """
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    checks = (
        DayStartStockCheck.objects
        .filter(operating_day__date__gte=start, operating_day__date__lte=end)
        .select_related("ingredient", "operating_day")
        .order_by("operating_day__date", "ingredient__name")
    )
    if outlet:
        checks = checks.filter(operating_day__outlet_id=outlet)

    rows = []
    total = Decimal("0")
    for chk in checks:
        shortfall = chk.discrepancy_qty
        if shortfall <= 0:
            continue
        cpu = chk.ingredient.cost_per_base_unit or Decimal("0")
        cost = (shortfall * cpu).quantize(Decimal("0.01"))
        total += cost
        rows.append({
            "date": str(chk.operating_day.date),
            "ingredient": chk.ingredient.name,
            "base_unit": chk.ingredient.base_unit,
            "system_qty": str(chk.system_carried_qty),
            "confirmed_qty": str(chk.confirmed_qty),
            "shortfall_qty": str(shortfall),
            "cost_per_unit": str(cpu),
            "cost": str(cost),
            "reason": chk.discrepancy_reason,
            "note": chk.note,
        })

    return Response({
        "start": start,
        "end": end,
        "total": str(total.quantize(Decimal("0.01"))),
        "rows": rows,
    })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def purchase_summary(request):
    """Total approved purchase cost for the period (what was actually paid to suppliers).

    Three-tier fallback per record:
      1. slip_grand_total — the slip's printed grand total (most accurate)
      2. Σ item.line_total — sum of per-line net amounts parsed from the slip
      3. pack_definition.cost_per_pack × confirmed_quantity — computed from registered cost

    ?start=&end=&outlet=
    """
    start, end = _default_range(request)
    outlet = request.query_params.get("outlet")

    records = (
        StockInRecord.objects
        .filter(
            status=StockInStatus.APPROVED,
            stock_in_date__gte=start,
            stock_in_date__lte=end,
        )
        .prefetch_related("items__pack_definition")
        .order_by("stock_in_date")
    )
    if outlet:
        records = records.filter(outlet_id=outlet)

    total = Decimal("0")
    daily: dict[str, Decimal] = {}
    rows = []

    for rec in records:
        if rec.slip_grand_total is not None:
            amount = rec.slip_grand_total
            source = "slip_total"
        else:
            amount = Decimal("0")
            source = "computed"
            for item in rec.items.all():
                if item.line_total is not None:
                    amount += item.line_total
                    source = "line_totals"
                elif item.pack_definition is not None:
                    if item.unit_captured == UnitCaptured.PACK:
                        amount += item.pack_definition.cost_per_pack * item.confirmed_quantity
                    elif item.pack_definition.pieces_per_pack:
                        cpu = item.pack_definition.cost_per_pack / item.pack_definition.pieces_per_pack
                        amount += cpu * item.confirmed_quantity

        total += amount
        d = str(rec.stock_in_date)
        daily[d] = daily.get(d, Decimal("0")) + amount

        rows.append({
            "id": rec.id,
            "date": d,
            "invoice_number": rec.invoice_number or "",
            "amount": amount.quantize(Decimal("0.01")),
            "source": source,
        })

    return Response({
        "start": start,
        "end": end,
        "total": total.quantize(Decimal("0.01")),
        "record_count": len(rows),
        "records": rows,
        "daily": [
            {"date": k, "amount": v.quantize(Decimal("0.01"))}
            for k, v in sorted(daily.items())
        ],
    })


def _do_rebuild(outlet: Outlet) -> dict:
    """Full RawStock rebuild replayed from all historical data. Returns summary dict."""
    _product_cache: dict[int, Product] = {}

    def get_product(pid: int) -> Product:
        if pid not in _product_cache:
            _product_cache[pid] = Product.objects.prefetch_related(
                "recipes__ingredient"
            ).get(id=pid)
        return _product_cache[pid]

    def all_dates() -> list:
        dates: set = set()
        for d in DayStartStockCheck.objects.filter(
            operating_day__outlet=outlet, confirmed_qty__isnull=False
        ).values_list("operating_day__date", flat=True):
            dates.add(d)
        for d in StockInItem.objects.filter(
            stock_in_record__outlet=outlet,
            stock_in_record__status=StockInStatus.APPROVED,
            ingredient__isnull=False,
        ).values_list("stock_in_record__stock_in_date", flat=True):
            dates.add(d)
        for log in PreparationLog.objects.filter(outlet=outlet, source=PrepSource.FRESH):
            dates.add(log.op_date or log.timestamp.date())
        for d in DailyClosingSalesLine.objects.filter(
            daily_closing__outlet_id=outlet.id
        ).values_list("daily_closing__closing_date", flat=True):
            dates.add(d)
        return sorted(dates)

    total_sets = total_adds = total_subs = 0

    with transaction.atomic():
        RawStock.objects.filter(outlet=outlet).update(quantity_available=Decimal("0"))

        for day in all_dates():
            for dsc in DayStartStockCheck.objects.filter(
                operating_day__outlet=outlet,
                operating_day__date=day,
                confirmed_qty__isnull=False,
            ).select_related("ingredient"):
                RawStock.set_to(outlet, dsc.ingredient, dsc.confirmed_qty)
                total_sets += 1

            for item in StockInItem.objects.filter(
                stock_in_record__outlet=outlet,
                stock_in_record__status=StockInStatus.APPROVED,
                stock_in_record__stock_in_date=day,
                ingredient__isnull=False,
            ).select_related("ingredient", "pack_definition"):
                ing = item.ingredient
                if ing.tracking_mode == TrackingMode.ONE_TIME:
                    continue
                delta = item.base_unit_quantity()
                if delta:
                    RawStock.adjust(outlet, ing, delta)
                    total_adds += 1

            prepped_pids: set[int] = set()
            for log in PreparationLog.objects.filter(
                outlet=outlet, source=PrepSource.FRESH,
            ).filter(
                Q(op_date=day) | Q(op_date__isnull=True, timestamp__date=day)
            ).prefetch_related("product__recipes__ingredient"):
                prepped_pids.add(log.product_id)
                for r in log.product.recipes.all():
                    delta = Decimal(str(log.pieces_prepared)) * r.quantity_per_unit
                    if delta:
                        RawStock.adjust(outlet, r.ingredient, -delta)
                        total_subs += 1

            sales_today: dict[int, int] = defaultdict(int)
            for row in DailyClosingSalesLine.objects.filter(
                daily_closing__outlet_id=outlet.id,
                daily_closing__closing_date=day,
            ).values("product_id", "quantity_sold"):
                sales_today[row["product_id"]] += row["quantity_sold"]

            for pid, qty in sales_today.items():
                if pid in prepped_pids:
                    continue
                prod = get_product(pid)
                for r in prod.recipes.all():
                    ing = r.ingredient
                    if ing.tracking_mode == TrackingMode.ONE_TIME:
                        continue
                    delta = Decimal(str(qty)) * r.quantity_per_unit
                    if delta:
                        RawStock.adjust(outlet, ing, -delta)
                        total_subs += 1

        stock = [
            {
                "ingredient": rs.ingredient.name,
                "quantity": float(rs.quantity_available),
                "unit": rs.ingredient.base_unit,
                "negative": rs.quantity_available < 0,
            }
            for rs in RawStock.objects.filter(outlet=outlet)
                .select_related("ingredient")
                .order_by("ingredient__name")
        ]

    return {
        "events": {"sets": total_sets, "adds": total_adds, "subs": total_subs},
        "stock": stock,
    }


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def rebuild_rawstock_api(request):
    """Full RawStock rebuild from all historical data. Body: {outlet: 1}"""
    outlet_id = int(request.data.get("outlet", 1))
    try:
        outlet = Outlet.objects.get(id=outlet_id)
    except Outlet.DoesNotExist:
        return Response({"error": "outlet not found"}, status=404)

    result = _do_rebuild(outlet)
    return Response({"ok": True, **result})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def day_overview(request):
    """Owner's consolidated day view: operating-day status, stock-in, prep log,
    display stock, day-start discrepancies, closing snapshot, and today's P&L.
    ?outlet=1&date=YYYY-MM-DD (date defaults to today)."""
    import datetime
    from django.db.models import Count

    outlet = request.query_params.get("outlet", "1")
    date_str = request.query_params.get("date")
    try:
        date = datetime.date.fromisoformat(date_str) if date_str else timezone.localdate()
    except ValueError:
        date = timezone.localdate()

    # ── Operating day ──────────────────────────────────────────────────────
    op_day = OperatingDay.objects.filter(outlet_id=outlet, date=date).first()
    op_day_data = None
    if op_day:
        op_day_data = {
            "id": op_day.id,
            "status": op_day.status,
            "started_at": op_day.started_at.isoformat() if op_day.started_at else None,
            "stock_confirmed_at": op_day.stock_confirmed_at.isoformat() if op_day.stock_confirmed_at else None,
            "carry_forward_confirmed_at": op_day.carry_forward_confirmed_at.isoformat() if op_day.carry_forward_confirmed_at else None,
        }

    # ── Day-start stock checks ─────────────────────────────────────────────
    def _display_name(ingredient):
        alias = next((a for a in ingredient.aliases.all() if a.is_active), None)
        return alias.alias_text if alias else ingredient.name

    day_start_checks = []
    if op_day:
        checks = list(
            DayStartStockCheck.objects.filter(operating_day=op_day)
            .select_related("ingredient")
            .prefetch_related("ingredient__aliases")
        )
        for chk in sorted(checks, key=lambda c: _display_name(c.ingredient).lower()):
            disc = chk.discrepancy_qty
            cpu = chk.ingredient.cost_per_base_unit or Decimal("0")
            shrinkage_cost = (max(disc, Decimal("0")) * cpu).quantize(Decimal("0.01"))
            day_start_checks.append({
                "ingredient": _display_name(chk.ingredient),
                "base_unit": chk.ingredient.base_unit,
                "system_qty": str(chk.system_carried_qty),
                "confirmed_qty": str(chk.confirmed_qty),
                "discrepancy_qty": str(disc),
                "discrepancy_reason": chk.discrepancy_reason,
                "note": chk.note,
                "shrinkage_cost": str(shrinkage_cost),
            })

    # ── Stock-in records for this date ────────────────────────────────────
    stock_ins_qs = StockInRecord.objects.filter(
        outlet_id=outlet, stock_in_date=date
    ).annotate(item_count=Count("items")).select_related("submitted_by").order_by("-id")
    stock_ins = [
        {
            "id": r.id,
            "status": r.status,
            "item_count": r.item_count,
            "submitted_by_name": r.submitted_by.name if r.submitted_by else "",
            "notes": r.notes,
            "invoice_number": r.invoice_number,
        }
        for r in stock_ins_qs
    ]

    # ── Prep logs for this date ───────────────────────────────────────────
    prep_logs_qs = PreparationLog.objects.filter(
        outlet_id=outlet, op_date=date
    ).select_related("product").order_by("timestamp")
    prep_logs = []
    for p in prep_logs_qs:
        price_obj = p.product.active_price(as_of=date)
        selling_price = price_obj.price if price_obj else Decimal("0")
        prep_logs.append({
            "id": p.id,
            "product_name": p.product.name,
            "product_category": p.product.category,
            "source": p.source,
            "prep_unit": p.prep_unit,
            "packs_used": str(p.packs_used) if p.packs_used is not None else None,
            "pieces_prepared": p.pieces_prepared,
            "wastage_pieces": p.wastage_pieces,
            "timestamp": p.timestamp.isoformat(),
            "selling_price": str(selling_price),
        })

    # ── Current display stock (prepared + ready-to-sell) ─────────────────
    from catalog.models import Recipe
    # Pre-fetch purchase cost per non-prep product (sum of recipe lines × ingredient cost).
    _display_qs = list(
        DisplayStock.objects.filter(outlet_id=outlet)
        .select_related("product")
        .order_by("product__category", "product__name")
    )
    non_prep_ids = [s.product_id for s in _display_qs if not s.product.requires_preparation]
    _recipe_cost: dict = {}
    for r in (
        Recipe.objects.filter(product_id__in=non_prep_ids)
        .select_related("ingredient")
        .prefetch_related("ingredient__pack_definitions")
    ):
        cost = (r.ingredient.cost_per_base_unit or Decimal("0")) * r.quantity_per_unit
        _recipe_cost[r.product_id] = _recipe_cost.get(r.product_id, Decimal("0")) + cost

    display_stock = []
    for s in _display_qs:
        if s.pieces_available <= 0:
            continue
        price_obj = s.product.active_price(as_of=date)
        selling_price = price_obj.price if price_obj else Decimal("0")
        purchase_price = _recipe_cost.get(s.product_id, Decimal("0")) if not s.product.requires_preparation else None
        display_stock.append({
            "product_name": s.product.name,
            "product_category": s.product.category,
            "pieces_available": s.pieces_available,
            "requires_preparation": s.product.requires_preparation,
            "selling_price": str(selling_price),
            "purchase_price": str(purchase_price) if purchase_price is not None else None,
        })

    # ── Raw ingredient stock (RECIPE_LINKED, qty > 0) ─────────────────────
    # Exclude ingredients that back non-preparation (beverage/ready) products —
    # those already appear in the "ready to sell" section via DisplayStock.
    ready_ingredient_ids = set(
        Recipe.objects.filter(product__requires_preparation=False)
        .values_list("ingredient_id", flat=True)
    )
    _raw_qs = [
        rs for rs in RawStock.objects.filter(
            outlet_id=outlet, ingredient__tracking_mode="RECIPE_LINKED"
        )
        .select_related("ingredient")
        .prefetch_related("ingredient__aliases", "ingredient__pack_definitions")
        if rs.quantity_available > 0 and rs.ingredient_id not in ready_ingredient_ids
    ]
    from catalog.utils import build_ingredient_category_map, build_ingredient_product_map, resolve_ingredient_group
    _category_map = build_ingredient_category_map()
    _product_map = build_ingredient_product_map()
    raw_stock = [
        {
            "ingredient": _display_name(rs.ingredient),
            "base_unit": rs.ingredient.base_unit,
            "quantity_available": str(rs.quantity_available),
            "cost_per_base_unit": str(rs.ingredient.cost_per_base_unit or Decimal("0")),
            "ingredient_group": resolve_ingredient_group(rs.ingredient, _category_map),
            "primary_product": _product_map.get(rs.ingredient_id, ""),
        }
        for rs in sorted(_raw_qs, key=lambda r: _display_name(r.ingredient).lower())
    ]

    # ── Closing snapshot ──────────────────────────────────────────────────
    closing_data = None
    closing = (
        DailyClosing.objects.filter(outlet_id=outlet, closing_date=date)
        .prefetch_related("stock_counts", "sales_lines__channel", "channel_discounts", "payments")
        .first()
    )
    if closing:
        flagged_counts = [sc for sc in closing.stock_counts.all() if sc.flag]
        def _price(sc):
            row = sc.product.active_price()
            return row.price if row else Decimal("0")
        closing_data = {
            "id": closing.id,
            "status": closing.status,
            "total_sale": str(closing.total_sale),
            "channel_day_net_revenue": str(closing.channel_day_net_revenue),
            "online_payments": str(closing.online_payments),
            "total_offline_sales": str(closing.total_offline_sales),
            "computed_cash": str(closing.computed_cash),
            "has_flag": closing.has_flag,
            "flagged_products": [
                {
                    "product_name": fc.product_name,
                    "derived_walkin_sold": fc.derived_walkin_sold,
                }
                for fc in flagged_counts
            ],
            "payments": [
                {
                    "account_name": p.account.name,
                    "is_primary_cash": p.account.is_primary_cash,
                    "amount": str(p.amount),
                }
                for p in closing.payments.select_related("account")
            ],
            "stock_counts_wastage": [
                {"product_name": sc.product.name, "wastage_pieces": sc.wastage_pieces}
                for sc in closing.stock_counts.select_related("product")
                if sc.wastage_pieces and sc.wastage_pieces > 0
            ],
            "stock_counts_remains": sorted(
                [
                    {
                        "product_name": sc.product.name,
                        "product_category": sc.product.category,
                        "remains_pieces": sc.remains_pieces,
                        "unit_price": str(_price(sc)),
                        "remains_value": str(
                            (_price(sc) * sc.remains_pieces).quantize(Decimal("0.01"))
                        ),
                    }
                    for sc in closing.stock_counts.select_related("product")
                    if sc.remains_pieces > 0 and not sc.product.requires_preparation
                ],
                key=lambda x: (x["product_category"], x["product_name"]),
            ),
            "total_remains_value": str(
                sum(
                    (_price(sc) * sc.remains_pieces
                     for sc in closing.stock_counts.select_related("product")
                     if sc.remains_pieces > 0 and not sc.product.requires_preparation),
                    Decimal("0"),
                ).quantize(Decimal("0.01"))
            ),
        }

    # ── Today's P&L ───────────────────────────────────────────────────────
    pnl = compute_pnl(date, date, outlet)

    return Response({
        "date": str(date),
        "operating_day": op_day_data,
        "day_start_checks": day_start_checks,
        "stock_ins": stock_ins,
        "prep_logs": prep_logs,
        "display_stock": display_stock,
        "raw_stock": raw_stock,
        "closing": closing_data,
        "pnl": {
            "revenue": str(pnl["revenue"]),
            "net_profit": str(pnl["net_profit"]),
            "cogs": str(pnl["cogs"]),
            "gross_profit": str(pnl["gross_profit"]),
        },
    })
