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
    PeriodicStockCheck,
    PrepSource,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
    StockInStatus,
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
