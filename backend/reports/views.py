"""Derived P&L, settlement variance, packaging, and dashboard reports.

Three distinct loss categories are kept separate, per the data model:
  COGS       — recipe cost of what was actually SOLD
  Wastage    — recipe cost of what was made but never sold (kitchen level)
  Shrinkage  — ingredient cost lost before prep (day-start storage level)
Packaging (periodic-count supplies) is reported as its own line as well.
"""
from collections import defaultdict
from decimal import Decimal

from django.core.cache import cache
from django.db import transaction
from django.db.models import Prefetch, Q, Sum
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from catalog.models import Outlet, Product, ProductType, TrackingMode
from closing.models import (
    ChannelSettlement,
    ClosingStatus,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    LineSource,
    PaymentEntry,
)
from costs.models import CostType, Expense
from income.models import OtherIncome
from sales.models import SalesChannel, SettlementType
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
    COGS uses the price that was active on the date of sale/wastage/shrinkage.
    Cached for 30 minutes — busted automatically when pack prices change."""
    _CACHE_KEY = "reports:pack_history"
    cached = cache.get(_CACHE_KEY)
    if cached is not None:
        return cached

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
    cache.set(_CACHE_KEY, history, timeout=1800)
    return history


def _bulk_active_prices(product_ids, as_of):
    """Return {product_id: Decimal price} for the active ProductPrice on `as_of`.
    Single query covering all products — eliminates N+1 from calling active_price()
    per product in loops."""
    from catalog.models import ProductPrice
    if not product_ids:
        return {}
    rows = (
        ProductPrice.objects.filter(
            product_id__in=product_ids,
            effective_from__lte=as_of,
        )
        .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=as_of))
        .order_by("product_id", "-effective_from")
        .values("product_id", "price")
    )
    result: dict = {}
    for row in rows:
        pid = row["product_id"]
        if pid not in result:  # first row per product = highest effective_from
            result[pid] = Decimal(str(row["price"]))
    return result


def _sales_by_product(sales_lines):
    """Aggregate a list of DailyClosingSalesLine rows into
    {product_id: {product_name, product_category, requires_preparation,
    walkin_sold, online_sold, revenue}}.

    Sourced from the sales lines themselves (not DailyClosingStockCount's
    derived_walkin_sold/app_channel_sold) so it always agrees with whatever a
    sell correction most recently wrote — see the day_overview caller."""
    result: dict = {}
    for line in sales_lines:
        agg = result.setdefault(line.product_id, {
            "product_name": line.product.name,
            "product_category": line.product.category,
            "requires_preparation": line.product.requires_preparation,
            "walkin_sold": 0,
            "online_sold": 0,
            "revenue": Decimal("0"),
        })
        if line.channel.is_walk_in:
            agg["walkin_sold"] += line.quantity_sold
        else:
            agg["online_sold"] += line.quantity_sold
        agg["revenue"] += line.gross_amount
    return result


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
    lines = (
        DailyClosingSalesLine.objects.filter(
            daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
        )
        .select_related("product", "daily_closing")
        .prefetch_related("product__recipes__ingredient", "product__components__component_product__recipes__ingredient")
    )
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
    counts = (
        DailyClosingStockCount.objects.filter(
            daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
        )
        .select_related("product", "daily_closing")
        .prefetch_related("product__recipes__ingredient")
    )
    if outlet:
        counts = counts.filter(daily_closing__outlet_id=outlet)
    for c in counts:
        if c.wastage_pieces:
            waste_date = c.daily_closing.closing_date
            total += _product_unit_cost(c.product, cost_cache, on_date=waste_date, pack_history=pack_history) * c.wastage_pieces

    carried = (
        PreparationLog.objects.filter(
            source=PrepSource.CARRIED_FORWARD,
            timestamp__date__gte=start, timestamp__date__lte=end,
        )
        .select_related("product")
        .prefetch_related("product__recipes__ingredient")
    )
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

    channel_discounts = DailyChannelDiscount.objects.filter(
        daily_closing__closing_date__gte=start, daily_closing__closing_date__lte=end
    )
    if outlet:
        channel_discounts = channel_discounts.filter(daily_closing__outlet_id=outlet)
    channel_discount_total = sum((d.discount_amount for d in channel_discounts), Decimal("0"))
    # Materialize once; gross_revenue is the face-value sold, commission is the platform cut.
    lines_list = list(lines)
    gross_revenue_total = sum((l.gross_amount for l in lines_list), Decimal("0"))
    commission_total = sum((l.commission_amount for l in lines_list), Decimal("0"))
    revenue = gross_revenue_total - commission_total - channel_discount_total
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
        "gross_revenue": gross_revenue_total,
        "commission_total": commission_total,
        "channel_discount": channel_discount_total,
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
    ).select_related("product", "daily_closing").prefetch_related(
        "product__recipes__ingredient",
        "product__components__component_product__recipes__ingredient",
    )
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)

    cost_cache = {}
    pack_history = _build_pack_history()
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
        unit_cost = _product_unit_cost(
            line.product, cost_cache,
            on_date=line.daily_closing.closing_date,
            pack_history=pack_history,
        )
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

    total_count = len(rows)
    limit_param = request.query_params.get("limit")
    if limit_param and limit_param.isdigit():
        rows = rows[:int(limit_param)]
    return Response({"start": start, "end": end, "rows": rows, "total_count": total_count, "range_clamped": range_clamped})


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
            "units_sold": 0, "gross_revenue": Decimal("0"), "net_revenue": Decimal("0"), "cogs": Decimal("0"),
        })
        prod["units_sold"] += line.quantity_sold
        prod["gross_revenue"] += line.gross_amount
        prod["net_revenue"] += line.net_amount
        prod["cogs"] += line_cogs

        ch_name = line.channel.name if line.channel else "Walk-in"
        ch = by_channel.setdefault(ch_name, {"channel": ch_name, "units_sold": 0, "net_revenue": Decimal("0"), "gross_revenue": Decimal("0")})
        ch["units_sold"] += line.quantity_sold
        ch["net_revenue"] += line.net_amount
        ch["gross_revenue"] += line.gross_amount

    q, q1 = Decimal("0.01"), Decimal("0.1")

    daily = [
        {"date": k, "units_sold": v["units_sold"],
         "revenue": str(v["revenue"].quantize(q)), "cogs": str(v["cogs"].quantize(q))}
        for k, v in sorted(by_date.items())
    ]

    all_sorted_products = sorted(by_product.values(), key=lambda x: -x["gross_revenue"])
    top_products = []
    for p in all_sorted_products[:7]:
        gp = p["net_revenue"] - p["cogs"]
        margin = (gp / p["net_revenue"] * 100) if p["net_revenue"] else Decimal("0")
        top_products.append({
            "product_name": p["product_name"], "category": p["category"],
            "units_sold": p["units_sold"],
            "revenue": str(p["gross_revenue"].quantize(q)), "cogs": str(p["cogs"].quantize(q)),
            "gross_profit": str(gp.quantize(q)), "margin_pct": str(margin.quantize(q1)),
        })

    channels = []
    for ch, v in sorted(by_channel.items(), key=lambda x: -x[1]["gross_revenue"]):
        channels.append({
            "channel": ch, "units_sold": v["units_sold"],
            "revenue": str(v["gross_revenue"].quantize(q)),
            "commission": str((v["gross_revenue"] - v["net_revenue"]).quantize(q)),
        })

    return Response({
        "start": start, "end": end,
        "pnl": compute_pnl(start, end, outlet),
        "daily": daily,
        "top_products": top_products,
        "top_products_total": len(all_sorted_products),
        "channels": channels,
    })


def _product_remaining_stock(product: Product, outlet_id):
    """Units of product that can still be made from current RawStock, plus
    the bottleneck ingredient's own raw quantity/pack size — so callers can
    show "5 makeable = 1 pack + 2 piece in stock" instead of a bare number.
    Returns (minimum, pack_info); pack_info is
    {"quantity_available": Decimal, "pieces_per_pack": Decimal|None, "base_unit": str}
    for whichever ingredient is the limiting one, or (None, None) if the
    product has no (non-packaging) recipe ingredients.
    PERIODIC_COUNT ingredients (packaging/supplies — sticks, bags, sauce
    sachets) are excluded: they're tracked separately via a coarse
    consumption-ratio signal, not a per-unit blocker, per the data model."""
    recipes = [
        r for r in product.recipes.select_related("ingredient").all()
        if r.ingredient.tracking_mode != TrackingMode.PERIODIC_COUNT
    ]
    if not recipes:
        return None, None
    availabilities = []
    for r in recipes:
        rs = RawStock.objects.filter(outlet_id=outlet_id, ingredient=r.ingredient).first()
        qty = rs.quantity_available if rs else Decimal("0")
        available = int(qty / r.quantity_per_unit) if r.quantity_per_unit else int(qty)
        availabilities.append((available, qty, r.ingredient))
    minimum = min(a for a, _, _ in availabilities)
    _, bottleneck_qty, bottleneck_ing = next(a for a in availabilities if a[0] == minimum)
    pack = bottleneck_ing.active_pack()
    pack_info = {
        "quantity_available": bottleneck_qty,
        "pieces_per_pack": pack.pieces_per_pack if pack else None,
        "base_unit": bottleneck_ing.base_unit,
    }
    return minimum, pack_info


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def product_stock_detail(request):
    """Per-ingredient breakdown behind a product's Sell-history "Stock" figure —
    explains which ingredient is the bottleneck (e.g. a Burger's Bun ran low
    while the Zinger Fillet didn't). Same "units still makeable" arithmetic as
    _product_remaining_stock, just broken out per ingredient instead of
    collapsed to the minimum.

    ?outlet=1&product=<id>
    """
    outlet = request.query_params.get("outlet", "1")
    product_id = request.query_params.get("product")
    if not product_id:
        return Response({"error": "product required"}, status=400)
    try:
        product = Product.objects.prefetch_related(
            "recipes__ingredient", "recipes__ingredient__aliases"
        ).get(id=product_id)
    except Product.DoesNotExist:
        return Response({"error": "product not found"}, status=404)

    recipes = list(product.recipes.select_related("ingredient").all())
    ingredients = []
    minimum = None
    for r in recipes:
        rs = RawStock.objects.filter(outlet_id=outlet, ingredient=r.ingredient).first()
        qty = rs.quantity_available if rs else Decimal("0")
        qty_per = r.quantity_per_unit or Decimal("1")
        possible = int(qty / qty_per)
        # PERIODIC_COUNT ingredients (packaging/supplies) are shown for
        # context but never gate the bottleneck — they're tracked separately
        # via a coarse consumption-ratio signal, not a per-unit blocker.
        is_periodic = r.ingredient.tracking_mode == TrackingMode.PERIODIC_COUNT
        if not is_periodic:
            minimum = possible if minimum is None else min(minimum, possible)
        pack = r.ingredient.active_pack()
        # Display name = the supplier-slip alias staff actually recognize
        # (e.g. "Zinger Fillet" on the slip vs. the catalog's full name) —
        # same resolution as everywhere else ingredient names surface.
        alias = next((a for a in r.ingredient.aliases.all() if a.is_active), None)
        ingredients.append({
            "ingredient_id": r.ingredient_id,
            "ingredient_name": alias.alias_text if alias else r.ingredient.name,
            "base_unit": r.ingredient.base_unit,
            "quantity_available": str(qty),
            "quantity_per_unit": str(qty_per),
            "pieces_possible": possible,
            "pieces_per_pack": str(pack.pieces_per_pack) if pack else None,
            "is_periodic": is_periodic,
        })
    for ing in ingredients:
        ing["is_bottleneck"] = (
            not ing["is_periodic"] and minimum is not None and ing["pieces_possible"] == minimum
        )

    return Response({
        "product_id": product.id,
        "product_name": product.name,
        "current_stock": minimum,
        "ingredients": ingredients,
    })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def sell_history(request):
    """
    Date-wise sell quantities AND that day's raw-ingredient stock (day-start
    reading plus anything approved-stock-in received that same day), per
    product — so a quiet day reads correctly: no/low stock that day (can't
    blame demand) vs. stock was there and it just didn't sell (real low
    demand). Includes any active product with zero sales in the range as
    long as it has SOME stock history that period (the extreme case of "out
    of stock the whole period" is exactly what this is meant to surface, not
    hide) — but skips products with neither sales nor any stock-in/day-start
    reading at all, since those were never actually stocked or sold and just
    clutter the list.
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
        .select_related("daily_closing")
    )
    if outlet:
        lines = lines.filter(daily_closing__outlet_id=outlet)

    # {product_id: {date_str: qty}}
    sales: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    dates_set: set[str] = set()
    for row in lines.values("product_id", "quantity_sold", "daily_closing__closing_date"):
        d = str(row["daily_closing__closing_date"])
        sales[row["product_id"]][d] += row["quantity_sold"]
        dates_set.add(d)

    # {date_str: {ingredient_id: confirmed_qty}} — raw ingredient stock at the
    # START of each day, from the day-start check. Deliberately NOT
    # DailyClosingStockCount.available_pieces: that figure is how much staff
    # actually PREPARED that day, which is a staffing/time decision and can
    # under-report what the raw ingredients on hand could really support.
    day_start_checks = (
        DayStartStockCheck.objects
        .filter(operating_day__date__gte=start, operating_day__date__lte=end)
    )
    if outlet:
        day_start_checks = day_start_checks.filter(operating_day__outlet_id=outlet)

    day_start_by_date: dict[str, dict[int, Decimal]] = defaultdict(dict)
    for row in day_start_checks.values("operating_day__date", "ingredient_id", "confirmed_qty"):
        d = str(row["operating_day__date"])
        day_start_by_date[d][row["ingredient_id"]] = row["confirmed_qty"]
        dates_set.add(d)

    # {date_str: {ingredient_id: qty}} — approved stock-in received DURING
    # that day, added on top of the day-start reading. Without this, a
    # delivery that arrives mid-day would make the day's raw-stock figure
    # look artificially low next to what was actually sellable that day.
    stock_in_items = (
        StockInItem.objects
        .filter(
            stock_in_record__status=StockInStatus.APPROVED,
            stock_in_record__stock_in_date__gte=start,
            stock_in_record__stock_in_date__lte=end,
            ingredient__isnull=False,
        )
        .select_related("pack_definition", "stock_in_record")
    )
    if outlet:
        stock_in_items = stock_in_items.filter(stock_in_record__outlet_id=outlet)

    stock_in_by_date: dict[str, dict[int, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    for item in stock_in_items:
        d = str(item.stock_in_record.stock_in_date)
        stock_in_by_date[d][item.ingredient_id] += item.base_unit_quantity()

    sorted_dates = sorted(dates_set)

    products = list(
        Product.objects.filter(is_active=True)
        .prefetch_related("recipes__ingredient")
        .order_by("category", "name")
    )

    def day_start_stock_for(product, d):
        """Units of `product` the raw ingredients on hand could make on date
        `d` — day-start reading + anything approved-stock-in that same day —
        at the bottleneck (lowest) ingredient, same rule as
        _product_remaining_stock/product_stock_detail. None when any recipe
        ingredient has no day-start reading for that date (unknown, not zero).
        PERIODIC_COUNT ingredients (packaging/supplies) are excluded — they
        never get a day-start check (that flow only covers RECIPE_LINKED
        ingredients), so including one would make every date permanently
        unknown for any product that uses one, even though the real
        ingredient may be perfectly well tracked."""
        recipes = [
            r for r in product.recipes.all()
            if r.ingredient.tracking_mode != TrackingMode.PERIODIC_COUNT
        ]
        if not recipes:
            return None
        raw_for_date = day_start_by_date.get(d)
        if raw_for_date is None:
            return None
        stock_in_for_date = stock_in_by_date.get(d, {})
        minimum = None
        for r in recipes:
            day_start_qty = raw_for_date.get(r.ingredient_id)
            if day_start_qty is None:
                return None
            raw_qty = day_start_qty + stock_in_for_date.get(r.ingredient_id, Decimal("0"))
            qty_per = r.quantity_per_unit or Decimal("1")
            possible = int(raw_qty / qty_per)
            minimum = possible if minimum is None else min(minimum, possible)
        return minimum

    rows = []
    for product in products:
        pid = product.id
        daily = {d: sales[pid].get(d, 0) for d in sorted_dates}
        daily_stock = {d: day_start_stock_for(product, d) for d in sorted_dates}
        total = sum(daily.values())
        # Skip products with no history at all in this range — no sales AND
        # no day-start/stock-in reading on any date — rather than padding the
        # list with items that were never actually stocked or sold.
        if total == 0 and all(v is None for v in daily_stock.values()):
            continue
        stock, stock_pack_info = _product_remaining_stock(product, outlet) if outlet else (None, None)
        rows.append({
            "id": pid,
            "name": product.name,
            "category": product.category or "",
            "daily": daily,
            "daily_stock": daily_stock,
            "total": total,
            "stock": stock,
            "stock_pack": {
                "quantity_available": str(stock_pack_info["quantity_available"]),
                "pieces_per_pack": (
                    str(stock_pack_info["pieces_per_pack"]) if stock_pack_info["pieces_per_pack"] else None
                ),
                "base_unit": stock_pack_info["base_unit"],
            } if stock_pack_info else None,
        })

    # Per-day open/close context — a short-staffed or late-opened day is
    # another reason sales can be low that has nothing to do with demand.
    # started_at is when staff began the day (closest proxy to "doors open");
    # submitted_at is when the closing was wrapped up ("doors closed").
    op_days = OperatingDay.objects.filter(date__gte=start, date__lte=end)
    if outlet:
        op_days = op_days.filter(outlet_id=outlet)
    opened_map = {str(od.date): od.started_at for od in op_days}

    closings_for_hours = DailyClosing.objects.filter(closing_date__gte=start, closing_date__lte=end)
    if outlet:
        closings_for_hours = closings_for_hours.filter(outlet_id=outlet)
    closed_map = {str(c.closing_date): c.submitted_at for c in closings_for_hours}

    date_hours = {}
    for d in sorted_dates:
        opened = opened_map.get(d)
        closed = closed_map.get(d)
        hours_open = None
        if opened and closed and closed > opened:
            hours_open = round((closed - opened).total_seconds() / 3600, 1)
        date_hours[d] = {
            "opened_at": opened.isoformat() if opened else None,
            "closed_at": closed.isoformat() if closed else None,
            "hours_open": hours_open,
        }

    return Response({
        "dates": sorted_dates,
        "rows": rows,
        "date_hours": date_hours,
        "range_clamped": range_clamped,
    })


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
    Body: {outlet: 1, date: "YYYY-MM-DD", corrections: [{product_id, new_qty}],
           fix_stock?: bool, fix_cash?: bool}

    fix_stock (default true) — reverse the raw-ingredient stock and prep-log
    for the quantity delta. Turn this OFF when the stock side has already been
    corrected some other way (e.g. today's Day-Start Stock Check already
    absorbed the discrepancy this sale error caused) — applying it again would
    double-count the adjustment.

    fix_cash (default true) — if the day is already SUBMITTED/LOCKED (so its
    cash total was already posted to the ledger), re-sync the primary-cash
    PaymentEntry and re-post the account transactions from the corrected
    numbers. Turn this OFF if you only want to fix the recorded sale/stock
    without touching the cash account (rare — usually you want both).
    """
    from datetime import date as date_cls
    outlet_id = int(request.data.get("outlet", 1))
    date_str = request.data.get("date")
    corrections = request.data.get("corrections", [])
    fix_stock = bool(request.data.get("fix_stock", True))
    fix_cash = bool(request.data.get("fix_cash", True))

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
                else:
                    try:
                        price, _ = resolve_price(product, walk_in, target_date)
                    except Exception:
                        price = product.selling_price
                    walkin_line = DailyClosingSalesLine(
                        daily_closing=daily_closing,
                        product=product,
                        channel=walk_in,
                        quantity_sold=new_walkin,
                        unit_price=price,
                        source=LineSource.SYSTEM_DERIVED,
                    )
                # gross_amount/commission_amount/net_amount are stored, not
                # computed on read — recompute() must run before save() or
                # computed_cash (which sums net_amount) silently stays stale
                # at the pre-correction total.
                walkin_line.recompute()
                walkin_line.save()

            if fix_stock:
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
                "stock_adjusted": fix_stock,
            })

        if errors:
            raise ValueError("; ".join(errors))

        # The sales-line edits above only change what computed_cash WOULD
        # report if recalculated — they don't touch money already posted to
        # the ledger when this day was submitted/locked. Reconcile that too,
        # unless the caller explicitly opted out (e.g. because only the stock
        # side needed fixing, or vice versa). Posts a standalone ADJUSTMENT
        # entry for the delta rather than rewriting the original SALES_
        # COLLECTION entry — see closing.services.post_cash_correction.
        cash_resynced = fix_cash and bool(applied) and daily_closing.status != ClosingStatus.DRAFT
        if cash_resynced:
            from closing import services as closing_services
            note = "Sell correction for {} — {}".format(
                daily_closing.closing_date,
                ", ".join(f"{a['product']} {a['old_qty']}→{a['new_qty']}" for a in applied),
            )
            closing_services.post_cash_correction(daily_closing, request.user, note)

    return Response({"ok": True, "applied": applied, "cash_resynced": cash_resynced})


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
                # NOTE: this is an absolute overwrite, trusting confirmed_qty as the
                # day's checkpoint. That's what makes a late-dated stock-in approved
                # after this day's check was confirmed get silently discarded once
                # the replay reaches this day (the 2026-09-11 incident) — but an
                # additive alternative (RawStock.adjust(confirmed - system_carried))
                # was tried and reverted: it fixes that case but uncovers *other*,
                # unrelated day/date-attribution gaps elsewhere in this outlet's
                # ledger history, which set_to's daily reset was silently masking,
                # and flips a *different* set of ingredients negative instead.
                # The real fix is keeping confirmed_qty always accurate at the
                # moment a backdated stock-in is approved — see
                # stock.services.reconcile_backdated_stock_in, called from
                # StockInRecordViewSet.approve and historic_import.import_stock_in_slip.
                # As long as that holds, trusting confirmed_qty here is correct.
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
    ?outlet=1&date=YYYY-MM-DD (date defaults to today).

    Performance: all product prices loaded in one bulk query; closing stock_counts
    materialised once from the prefetch cache; catalog lookups are in-process cached."""
    import datetime
    from django.db.models import Count
    from catalog.models import Recipe
    from catalog.utils import build_ingredient_category_map, build_ingredient_product_map, resolve_ingredient_group

    outlet = request.query_params.get("outlet", "1")
    date_str = request.query_params.get("date")
    try:
        date = datetime.date.fromisoformat(date_str) if date_str else timezone.localdate()
    except ValueError:
        date = timezone.localdate()

    # ── Catalog lookups (in-process cached) ───────────────────────────────
    _category_map = build_ingredient_category_map()
    _product_map = build_ingredient_product_map()

    def _display_name(ingredient):
        cache_ = getattr(ingredient, "_prefetched_objects_cache", {})
        if "aliases" in cache_:
            alias = next((a for a in ingredient.aliases.all() if a.is_active), None)
        else:
            alias = ingredient.aliases.filter(is_active=True).first()
        return alias.alias_text if alias else ingredient.name

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

    # ── Load all querysets up-front ────────────────────────────────────────

    # Day-start stock checks
    day_start_checks_raw = []
    if op_day:
        day_start_checks_raw = list(
            DayStartStockCheck.objects.filter(operating_day=op_day)
            .select_related("ingredient")
            .prefetch_related("ingredient__aliases", "ingredient__pack_definitions")
        )

    # Stock-in records
    stock_ins_raw = list(
        StockInRecord.objects.filter(outlet_id=outlet, stock_in_date=date)
        .annotate(item_count=Count("items"))
        .select_related("submitted_by")
        .order_by("-id")
    )

    # Prep logs
    prep_logs_raw = list(
        PreparationLog.objects.filter(outlet_id=outlet, op_date=date)
        .select_related("product")
        .order_by("timestamp")
    )

    # Display stock + non-prep recipe cost + pack info
    _display_qs = list(
        DisplayStock.objects.filter(outlet_id=outlet)
        .select_related("product")
        .order_by("product__category", "product__name")
    )
    # Non-prep products needing pack info: anything with a DisplayStock row,
    # PLUS anything sold today — a product a sell correction touches may have
    # no DisplayStock row for whatever reason, but the Sales section should
    # still show its pack breakdown, same as Display/Raw stock do for theirs.
    _sold_today_ids = set(
        DailyClosingSalesLine.objects.filter(
            daily_closing__outlet_id=outlet, daily_closing__closing_date=date,
        ).values_list("product_id", flat=True)
    )
    non_prep_ids = list(set(
        s.product_id for s in _display_qs if not s.product.requires_preparation
    ) | set(
        Product.objects.filter(id__in=_sold_today_ids, requires_preparation=False)
        .values_list("id", flat=True)
    ))
    _recipe_cost: dict = {}
    _non_prep_pack: dict = {}
    ready_ingredient_ids: set = set()  # avoids a second Recipe query below
    for r in (
        Recipe.objects.filter(product_id__in=non_prep_ids)
        .select_related("ingredient")
        .prefetch_related("ingredient__pack_definitions")
    ):
        cost = (r.ingredient.cost_per_base_unit or Decimal("0")) * r.quantity_per_unit
        _recipe_cost[r.product_id] = _recipe_cost.get(r.product_id, Decimal("0")) + cost
        ready_ingredient_ids.add(r.ingredient_id)
        if r.product_id not in _non_prep_pack:
            active_pack = r.ingredient.active_pack()
            if active_pack:
                _non_prep_pack[r.product_id] = active_pack.pieces_per_pack

    # Raw ingredient stock
    raw_stock_raw = list(
        rs for rs in (
            RawStock.objects.filter(outlet_id=outlet, ingredient__tracking_mode="RECIPE_LINKED")
            .select_related("ingredient")
            .prefetch_related("ingredient__aliases", "ingredient__pack_definitions")
        )
        if rs.ingredient_id not in ready_ingredient_ids
    )

    # Closing — prefetch stock_counts+product and payments+account in one shot
    closing = (
        DailyClosing.objects.filter(outlet_id=outlet, closing_date=date)
        .prefetch_related(
            "stock_counts__product",
            Prefetch(
                "sales_lines",
                queryset=DailyClosingSalesLine.objects.select_related("channel", "product"),
            ),
            "channel_discounts",
            Prefetch(
                "payments",
                queryset=PaymentEntry.objects.select_related("account"),
            ),
        )
        .first()
    )

    # ── Bulk-load active prices (one query covers all sections) ────────────
    all_product_ids: set = set()
    for p in prep_logs_raw:
        all_product_ids.add(p.product_id)
    for s in _display_qs:
        if s.pieces_available > 0:
            all_product_ids.add(s.product_id)
    if closing:
        for sc in closing.stock_counts.all():  # uses prefetch cache — no extra query
            all_product_ids.add(sc.product_id)
    price_map = _bulk_active_prices(all_product_ids, date)

    # ── Serialise sections ─────────────────────────────────────────────────

    # Day-start stock checks
    day_start_checks = []
    for chk in sorted(day_start_checks_raw, key=lambda c: _display_name(c.ingredient).lower()):
        disc = chk.discrepancy_qty
        cpu = chk.ingredient.cost_per_base_unit or Decimal("0")
        shrinkage_cost = (max(disc, Decimal("0")) * cpu).quantize(Decimal("0.01"))
        active_pack = chk.ingredient.active_pack()
        day_start_checks.append({
            "ingredient": _display_name(chk.ingredient),
            "base_unit": chk.ingredient.base_unit,
            "system_qty": str(chk.system_carried_qty),
            "confirmed_qty": str(chk.confirmed_qty),
            "discrepancy_qty": str(disc),
            "discrepancy_reason": chk.discrepancy_reason,
            "note": chk.note,
            "shrinkage_cost": str(shrinkage_cost),
            "pieces_per_pack": str(active_pack.pieces_per_pack) if active_pack else None,
            "ingredient_group": resolve_ingredient_group(chk.ingredient, _category_map),
        })

    # Stock-in records
    stock_ins = [
        {
            "id": r.id,
            "status": r.status,
            "item_count": r.item_count,
            "submitted_by_name": r.submitted_by.name if r.submitted_by else "",
            "notes": r.notes,
            "invoice_number": r.invoice_number,
        }
        for r in stock_ins_raw
    ]

    # Prep logs — price from bulk map, no per-row query
    prep_logs = [
        {
            "id": p.id,
            "product_name": p.product.name,
            "product_category": p.product.category,
            "source": p.source,
            "prep_unit": p.prep_unit,
            "packs_used": str(p.packs_used) if p.packs_used is not None else None,
            "pieces_prepared": p.pieces_prepared,
            "wastage_pieces": p.wastage_pieces,
            "timestamp": p.timestamp.isoformat(),
            "selling_price": str(price_map.get(p.product_id, Decimal("0"))),
        }
        for p in prep_logs_raw
    ]

    day_is_closed = op_day is not None and op_day.status == "CLOSED"

    if day_is_closed and closing:
        # ── Historical display stock: closing stock count remains ──────────────
        stock_counts_for_display = list(closing.stock_counts.all())  # prefetch hit

        # Build purchase-price + pack maps for non-prep products from closing data
        hist_non_prep_ids = [sc.product_id for sc in stock_counts_for_display if not sc.product.requires_preparation]
        hist_recipe_cost: dict = {}
        hist_non_prep_pack: dict = {}
        hist_ready_ing_ids: set = set()
        for r in (
            Recipe.objects.filter(product_id__in=hist_non_prep_ids)
            .select_related("ingredient")
            .prefetch_related("ingredient__pack_definitions")
        ):
            cost = (r.ingredient.cost_per_base_unit or Decimal("0")) * r.quantity_per_unit
            hist_recipe_cost[r.product_id] = hist_recipe_cost.get(r.product_id, Decimal("0")) + cost
            hist_ready_ing_ids.add(r.ingredient_id)
            if r.product_id not in hist_non_prep_pack:
                active_pack = r.ingredient.active_pack()
                if active_pack:
                    hist_non_prep_pack[r.product_id] = active_pack.pieces_per_pack

        display_stock = []
        for sc in sorted(stock_counts_for_display, key=lambda x: (x.product.category, x.product.name)):
            purchase_price = hist_recipe_cost.get(sc.product_id, Decimal("0")) if not sc.product.requires_preparation else None
            ppp = hist_non_prep_pack.get(sc.product_id) if not sc.product.requires_preparation else None
            display_stock.append({
                "product_name": sc.product.name,
                "product_category": sc.product.category,
                "pieces_available": sc.remains_pieces,
                "requires_preparation": sc.product.requires_preparation,
                "selling_price": str(price_map.get(sc.product_id, Decimal("0"))),
                "purchase_price": str(purchase_price) if purchase_price is not None else None,
                "pieces_per_pack": str(ppp) if ppp is not None else None,
            })

        # ── Historical raw stock: DayStart confirmed + StockIn − PrepConsumed ──
        from stock.models import StockInItem as _StockInItem

        # Per-ingredient approved stock-in for this date
        stockin_map: dict = {}      # ingredient_id -> Decimal pieces
        stockin_ing_cache: dict = {}
        for item in (
            _StockInItem.objects.filter(
                stock_in_record__outlet_id=outlet,
                stock_in_record__stock_in_date=date,
                stock_in_record__status="APPROVED",
                ingredient__isnull=False,
                ingredient__tracking_mode="RECIPE_LINKED",
            )
            .select_related("ingredient", "pack_definition")
            .prefetch_related("ingredient__aliases", "ingredient__pack_definitions")
        ):
            stockin_map[item.ingredient_id] = (
                stockin_map.get(item.ingredient_id, Decimal("0")) + item.base_unit_quantity()
            )
            stockin_ing_cache[item.ingredient_id] = item.ingredient

        # Per-ingredient consumption: fresh prep pieces × recipe quantity_per_unit
        fresh_pieces: dict = {}  # product_id -> total fresh pieces prepared
        for pl in prep_logs_raw:
            if pl.source == "FRESH":
                fresh_pieces[pl.product_id] = fresh_pieces.get(pl.product_id, 0) + pl.pieces_prepared

        consumed_map: dict = {}  # ingredient_id -> Decimal
        recipe_ing_cache: dict = {}
        if fresh_pieces:
            for r in (
                Recipe.objects.filter(
                    product_id__in=list(fresh_pieces.keys()),
                    ingredient__tracking_mode="RECIPE_LINKED",
                )
                .select_related("ingredient")
                .prefetch_related("ingredient__aliases", "ingredient__pack_definitions")
            ):
                recipe_ing_cache[r.ingredient_id] = r.ingredient
                delta = Decimal(fresh_pieces[r.product_id]) * r.quantity_per_unit
                consumed_map[r.ingredient_id] = consumed_map.get(r.ingredient_id, Decimal("0")) + delta

        # Merge all relevant ingredient IDs
        chk_by_ing = {chk.ingredient_id: chk for chk in day_start_checks_raw}
        all_ing_ids = set(chk_by_ing.keys()) | set(stockin_map.keys())

        raw_stock_entries = []
        for ing_id in all_ing_ids:
            chk = chk_by_ing.get(ing_id)
            if chk:
                ing = chk.ingredient
            else:
                ing = stockin_ing_cache.get(ing_id) or recipe_ing_cache.get(ing_id)
            if ing is None or ing.tracking_mode != "RECIPE_LINKED":
                continue
            if ing_id in hist_ready_ing_ids:
                continue  # shown as display_stock (non-prep product)

            opening = chk.confirmed_qty if chk else Decimal("0")
            day_end_qty = opening + stockin_map.get(ing_id, Decimal("0")) - consumed_map.get(ing_id, Decimal("0"))

            active_pack = ing.active_pack()
            raw_stock_entries.append({
                "ingredient": _display_name(ing),
                "base_unit": ing.base_unit,
                "quantity_available": str(day_end_qty.quantize(Decimal("0.001"))),
                "cost_per_base_unit": str(ing.cost_per_base_unit or Decimal("0")),
                "ingredient_group": resolve_ingredient_group(ing, _category_map),
                "primary_product": _product_map.get(ing_id, ""),
                "pieces_per_pack": str(active_pack.pieces_per_pack) if active_pack else None,
            })
        raw_stock = sorted(raw_stock_entries, key=lambda r: r["ingredient"].lower())

    else:
        # ── Live stock (today / non-closed day) ───────────────────────────────
        display_stock = []
        for s in _display_qs:
            purchase_price = _recipe_cost.get(s.product_id, Decimal("0")) if not s.product.requires_preparation else None
            ppp = _non_prep_pack.get(s.product_id) if not s.product.requires_preparation else None
            display_stock.append({
                "product_name": s.product.name,
                "product_category": s.product.category,
                "pieces_available": s.pieces_available,
                "requires_preparation": s.product.requires_preparation,
                "selling_price": str(price_map.get(s.product_id, Decimal("0"))),
                "purchase_price": str(purchase_price) if purchase_price is not None else None,
                "pieces_per_pack": str(ppp) if ppp is not None else None,
            })

        raw_stock = []
        for rs in sorted(raw_stock_raw, key=lambda r: _display_name(r.ingredient).lower()):
            active_pack = rs.ingredient.active_pack()
            raw_stock.append({
                "ingredient": _display_name(rs.ingredient),
                "base_unit": rs.ingredient.base_unit,
                "quantity_available": str(rs.quantity_available),
                "cost_per_base_unit": str(rs.ingredient.cost_per_base_unit or Decimal("0")),
                "ingredient_group": resolve_ingredient_group(rs.ingredient, _category_map),
                "primary_product": _product_map.get(rs.ingredient_id, ""),
                "pieces_per_pack": str(active_pack.pieces_per_pack) if active_pack else None,
            })

    # ── Closing snapshot — materialise stock_counts once, compute from memory ──
    closing_data = None
    if closing:
        stock_counts_list = list(closing.stock_counts.all())   # prefetch cache hit
        sales_lines_list = list(closing.sales_lines.all())     # prefetch cache hit
        payments_list = list(closing.payments.all())           # prefetch cache hit

        # Operational rollups use gross_amount (face-value sold) — commission is a P&L cost only
        total_sale = sum((l.gross_amount for l in sales_lines_list), Decimal("0"))
        online_payments = sum(
            (l.gross_amount for l in sales_lines_list
             if l.channel.settlement_type == SettlementType.DIRECT_TO_ACCOUNT),
            Decimal("0"),
        )
        total_offline_sales = total_sale - online_payments
        typed_non_cash = sum(
            (p.amount for p in payments_list if not p.account.is_primary_cash),
            Decimal("0"),
        )
        computed_cash = total_offline_sales - typed_non_cash
        has_flag = any(sc.flag for sc in stock_counts_list)

        def _price(sc):
            return price_map.get(sc.product_id, Decimal("0"))

        closing_data = {
            "id": closing.id,
            "status": closing.status,
            "total_sale": str(total_sale),
            "channel_day_net_revenue": str(total_sale),
            "online_payments": str(online_payments),
            "total_offline_sales": str(total_offline_sales),
            "computed_cash": str(computed_cash),
            "has_flag": has_flag,
            "flagged_products": [
                {
                    "product_name": sc.product.name,
                    "derived_walkin_sold": sc.derived_walkin_sold,
                }
                for sc in stock_counts_list if sc.flag
            ],
            "payments": [
                {
                    "account_name": p.account.name,
                    "is_primary_cash": p.account.is_primary_cash,
                    "amount": str(p.amount),
                }
                for p in payments_list
            ],
            "stock_counts_wastage": [
                {"product_name": sc.product.name, "wastage_pieces": sc.wastage_pieces}
                for sc in stock_counts_list
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
                    for sc in stock_counts_list
                    if sc.remains_pieces > 0 and sc.product.requires_preparation
                ],
                key=lambda x: (x["product_category"], x["product_name"]),
            ),
            "total_remains_value": str(
                sum(
                    (_price(sc) * sc.remains_pieces
                     for sc in stock_counts_list
                     if sc.remains_pieces > 0 and sc.product.requires_preparation),
                    Decimal("0"),
                ).quantize(Decimal("0.01"))
            ),
            # Built from sales_lines (DailyClosingSalesLine), NOT
            # DailyClosingStockCount.derived_walkin_sold/app_channel_sold —
            # those only get re-derived by recompute_closing() (staff
            # counts/online-sell steps), which reports.views.correct_sells
            # deliberately does not call when fixing an already-locked day
            # (see its docstring). Sourcing this from the same sales_lines_list
            # that total_sale/computed_cash above already use keeps this
            # section from ever going stale relative to a sell correction.
            "sales_by_product": sorted(
                [
                    {
                        "product_name": agg["product_name"],
                        "product_category": agg["product_category"],
                        "walkin_sold": agg["walkin_sold"],
                        "online_sold": agg["online_sold"],
                        "total_sold": agg["walkin_sold"] + agg["online_sold"],
                        "selling_price": str(price_map.get(product_id, Decimal("0"))),
                        "revenue": str(agg["revenue"].quantize(Decimal("0.01"))),
                        # Same convention as Display/Raw stock below: only
                        # direct-stock products (no prep step) have a
                        # meaningful pack size — one recipe ingredient unit
                        # per piece sold.
                        "pieces_per_pack": (
                            str(_non_prep_pack[product_id])
                            if not agg["requires_preparation"] and product_id in _non_prep_pack
                            else None
                        ),
                    }
                    for product_id, agg in _sales_by_product(sales_lines_list).items()
                    if agg["walkin_sold"] + agg["online_sold"] > 0
                ],
                key=lambda x: (x["product_category"], x["product_name"]),
            ),
        }

    # ── Today's P&L ───────────────────────────────────────────────────────
    pnl = compute_pnl(date, date, outlet)

    # ── Periodic stock checks (supplies) for the day ──────────────────────
    periodic_checks_raw = list(
        PeriodicStockCheck.objects.filter(outlet_id=outlet, checked_at__date=date)
        .select_related("ingredient", "checked_by")
        .prefetch_related("ingredient__aliases")
        .order_by("checked_at")
    )
    periodic_checks = []
    for pc in periodic_checks_raw:
        alias = next((a for a in pc.ingredient.aliases.all() if a.is_active), None)
        display_name = alias.alias_text if alias else pc.ingredient.name
        periodic_checks.append({
            "id": pc.id,
            "ingredient_name": display_name,
            "base_unit": pc.ingredient.base_unit,
            "counted_qty": str(pc.counted_qty),
            "consumed_since_last_check": str(pc.consumed_since_last_check),
            "stock_in_since_last_check": str(pc.stock_in_since_last_check),
            "note": pc.note,
            "checked_at": pc.checked_at.isoformat(),
            "checked_by_name": pc.checked_by.name if pc.checked_by else "",
        })

    # ── Approved stock-in for PERIODIC_COUNT ingredients (supplies) ───────
    from stock.models import StockInItem as _StockInItemPeriodicCheck
    from catalog.models import TrackingMode as _TrackingModePC
    supply_stock_ins = []
    for si_item in (
        _StockInItemPeriodicCheck.objects.filter(
            stock_in_record__outlet_id=outlet,
            stock_in_record__stock_in_date=date,
            stock_in_record__status="APPROVED",
            ingredient__isnull=False,
            ingredient__tracking_mode=_TrackingModePC.PERIODIC_COUNT,
        )
        .select_related(
            "ingredient", "pack_definition",
            "stock_in_record__reviewed_by", "stock_in_record__submitted_by",
        )
        .prefetch_related("ingredient__aliases")
        .order_by("stock_in_record__reviewed_at")
    ):
        alias = next((a for a in si_item.ingredient.aliases.all() if a.is_active), None)
        display_name = alias.alias_text if alias else si_item.ingredient.name
        reviewer = si_item.stock_in_record.reviewed_by
        supply_stock_ins.append({
            "ingredient_name": display_name,
            "base_unit": si_item.ingredient.base_unit,
            "quantity_added": str(si_item.base_unit_quantity()),
            "approved_at": si_item.stock_in_record.reviewed_at.isoformat()
                if si_item.stock_in_record.reviewed_at else None,
            "approved_by_name": reviewer.name if reviewer else "",
        })

    # ── Opening balance per PERIODIC_COUNT ingredient for the viewed date ─
    # Collect display_name → ingredient_id from all supply events today.
    from decimal import Decimal as _Decimal
    _supply_name_to_id: dict[str, int] = {}
    for pc in periodic_checks_raw:
        alias = next((a for a in pc.ingredient.aliases.all() if a.is_active), None)
        dname = alias.alias_text if alias else pc.ingredient.name
        _supply_name_to_id[dname] = pc.ingredient_id
    for si_entry in supply_stock_ins:
        # supply_stock_ins already built; re-derive id from the StockInItem query result
        pass  # ids collected below via direct query

    # Collect ingredient ids from today's stock-ins (supply_stock_ins has names, not ids)
    _supply_si_ids = list(
        _StockInItemPeriodicCheck.objects.filter(
            stock_in_record__outlet_id=outlet,
            stock_in_record__stock_in_date=date,
            stock_in_record__status="APPROVED",
            ingredient__isnull=False,
            ingredient__tracking_mode=_TrackingModePC.PERIODIC_COUNT,
        )
        .select_related("ingredient")
        .prefetch_related("ingredient__aliases")
        .values_list("ingredient_id", flat=True)
        .distinct()
    )
    supply_ing_ids = set(_supply_name_to_id.values()) | set(_supply_si_ids)

    supply_opening_levels: dict[str, str] = {}  # display_name → opening_qty
    # Build reverse map: ing_id → display_name (use periodic checks + a fresh alias lookup)
    _ing_id_to_name: dict[int, str] = {v: k for k, v in _supply_name_to_id.items()}
    # For ids only in stock-ins (no recount today), resolve display names
    _missing_ids = supply_ing_ids - set(_ing_id_to_name.keys())
    if _missing_ids:
        from catalog.models import Ingredient as _IngModel
        for _ing in _IngModel.objects.filter(id__in=_missing_ids).prefetch_related("aliases"):
            _alias = next((a for a in _ing.aliases.all() if a.is_active), None)
            _ing_id_to_name[_ing.id] = _alias.alias_text if _alias else _ing.name

    for ing_id in supply_ing_ids:
        last_check = (
            PeriodicStockCheck.objects.filter(
                outlet_id=outlet, ingredient_id=ing_id, checked_at__date__lt=date
            )
            .order_by("-checked_at")
            .first()
        )
        base_qty = _Decimal(str(last_check.counted_qty)) if last_check else _Decimal("0")
        base_time = last_check.checked_at if last_check else None

        # Stock-ins approved after base_time and strictly before the viewed date
        prior_si_qs = _StockInItemPeriodicCheck.objects.filter(
            ingredient_id=ing_id,
            stock_in_record__outlet_id=outlet,
            stock_in_record__status="APPROVED",
            stock_in_record__reviewed_at__date__lt=date,
        ).select_related("pack_definition")
        if base_time:
            prior_si_qs = prior_si_qs.filter(stock_in_record__reviewed_at__gte=base_time)
        for prior_si in prior_si_qs:
            base_qty += _Decimal(str(prior_si.base_unit_quantity()))

        display_name = _ing_id_to_name.get(ing_id, str(ing_id))
        supply_opening_levels[display_name] = str(base_qty)

    # ── Account transactions for the day ──────────────────────────────────
    from finance.models import AccountTransaction
    from django.db.models import Q
    txn_qs = (
        AccountTransaction.objects
        .filter(date=date)
        .filter(Q(account__outlet_id=outlet) | Q(account__outlet__isnull=True))
        .select_related("account")
        .order_by("id")
    )
    transactions = [
        {
            "id": t.id,
            "account_name": t.account.name,
            "account_type": t.account.account_type,
            "transaction_type": t.transaction_type,
            "amount": str(t.amount),
            "note": t.note,
        }
        for t in txn_qs
    ]

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
            "gross_revenue": str(pnl["gross_revenue"].quantize(Decimal("0.01"))),
            "commission_total": str(pnl["commission_total"].quantize(Decimal("0.01"))),
            "channel_discount": str(pnl["channel_discount"].quantize(Decimal("0.01"))),
            "revenue": str(pnl["revenue"].quantize(Decimal("0.01"))),
            "net_profit": str(pnl["net_profit"].quantize(Decimal("0.01"))),
            "cogs": str(pnl["cogs"].quantize(Decimal("0.01"))),
            "gross_profit": str(pnl["gross_profit"].quantize(Decimal("0.01"))),
        },
        "transactions": transactions,
        "periodic_checks": periodic_checks,
        "supply_stock_ins": supply_stock_ins,
        "supply_opening_levels": supply_opening_levels,
    })
