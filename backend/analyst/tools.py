"""Tool definitions and execution for the Claude analyst agent.

Each tool queries the database read-only and returns a formatted string.
Claude calls these on demand — no data is pre-fetched into the system prompt.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date
from decimal import Decimal

logger = logging.getLogger(__name__)

# ── Tool schemas (Anthropic format) ──────────────────────────────────────────

TOOL_SCHEMAS = [
    {
        "name": "get_pnl",
        "description": (
            "Get profit & loss for any date range: revenue, COGS, gross profit, "
            "wastage cost, shrinkage, fixed/variable/adhoc expenses, net profit."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_sales_breakdown",
        "description": (
            "Get sales breakdown by product and channel for any date range. "
            "Shows units sold and revenue per product, plus channel split."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_wastage_breakdown",
        "description": (
            "Get per-product wastage (pieces thrown away at closing) and remains "
            "(unsold pieces at close) for any date range."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_prep_log",
        "description": (
            "Get preparation log for any date range: what was prepared each day, "
            "source (fresh/carried forward), and in-prep wastage pieces."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_stock_in_history",
        "description": (
            "Get approved stock-in delivery records for any date range: "
            "what ingredients were received and in what quantities."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_current_stock",
        "description": (
            "Get today's current display stock (ready-to-sell pieces per product) "
            "and raw ingredient stock quantities."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "get_expenses",
        "description": "Get itemized expenses (fixed, variable, adhoc costs) for any date range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "get_operating_days",
        "description": (
            "Get operating days with their status for any date range. "
            "Useful for finding which days have data before querying them."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
            },
            "required": ["start_date", "end_date"],
        },
    },
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt(amount) -> str:
    if amount is None:
        return "—"
    try:
        return f"৳{Decimal(str(amount)):,.0f}"
    except Exception:
        return str(amount)


def _parse(s: str) -> date:
    return date.fromisoformat(s)


# ── Tool implementations ──────────────────────────────────────────────────────

def _get_pnl(inputs: dict, outlet_id) -> str:
    from reports.views import compute_pnl
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    p = compute_pnl(start, end, outlet_id)
    lines = [f"P&L {start} to {end}:"]
    lines.append(f"  Revenue: {_fmt(p['revenue'])}")
    lines.append(f"  COGS: {_fmt(p['cogs'])}")
    lines.append(f"  Gross profit: {_fmt(p['gross_profit'])}")
    if p.get("revenue"):
        gm = Decimal(str(p["gross_profit"])) / Decimal(str(p["revenue"])) * 100
        lines.append(f"  Gross margin: {gm:.1f}%")
    lines.append(f"  Wastage cost: {_fmt(p['wastage_cost'])}")
    lines.append(f"  Shrinkage: {_fmt(p['shrinkage_cost'])}")
    lines.append(f"  Fixed costs: {_fmt(p['fixed_costs'])}")
    lines.append(f"  Variable costs: {_fmt(p['variable_costs'])}")
    lines.append(f"  Adhoc costs: {_fmt(p['adhoc_costs'])}")
    lines.append(f"  Net profit: {_fmt(p['net_profit'])}")
    return "\n".join(lines)


def _get_sales_breakdown(inputs: dict, outlet_id) -> str:
    from closing.models import DailyClosingSalesLine
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    qs = (
        DailyClosingSalesLine.objects
        .filter(daily_closing__closing_date__range=(start, end))
        .select_related("product", "channel", "daily_closing")
    )
    if outlet_id:
        qs = qs.filter(daily_closing__outlet_id=outlet_id)
    lines_data = list(qs)
    if not lines_data:
        return f"No sales data for {start} to {end}."

    by_product: dict[str, dict] = {}
    by_channel: dict[str, dict] = {}
    total_rev = Decimal(0)
    total_units = 0
    for line in lines_data:
        p = by_product.setdefault(line.product.name, {"units": 0, "rev": Decimal(0)})
        p["units"] += line.quantity_sold
        p["rev"] += line.net_amount
        c = by_channel.setdefault(line.channel.name, {"units": 0, "rev": Decimal(0)})
        c["units"] += line.quantity_sold
        c["rev"] += line.net_amount
        total_rev += line.net_amount
        total_units += line.quantity_sold

    out = [f"Sales {start} to {end}: {total_units} units total, {_fmt(total_rev)}"]
    out.append("By product (units — revenue):")
    for name, d in sorted(by_product.items(), key=lambda x: -x[1]["units"]):
        out.append(f"  {name}: {d['units']} pcs — {_fmt(d['rev'])}")
    out.append("By channel:")
    for name, d in sorted(by_channel.items(), key=lambda x: -x[1]["rev"]):
        pct = d["rev"] / total_rev * 100 if total_rev else Decimal(0)
        out.append(f"  {name}: {_fmt(d['rev'])} ({pct:.0f}%) — {d['units']} units")
    return "\n".join(out)


def _get_wastage_breakdown(inputs: dict, outlet_id) -> str:
    from closing.models import DailyClosing, DailyClosingStockCount
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    closings = DailyClosing.objects.filter(closing_date__range=(start, end))
    if outlet_id:
        closings = closings.filter(outlet_id=outlet_id)
    closing_ids = list(closings.values_list("id", flat=True))
    if not closing_ids:
        return f"No closing data for {start} to {end}."

    counts = list(
        DailyClosingStockCount.objects
        .filter(daily_closing_id__in=closing_ids)
        .select_related("product", "daily_closing")
    )
    if not counts:
        return f"No stock count data for {start} to {end}."

    by_wastage: dict[str, int] = defaultdict(int)
    by_remains: dict[str, int] = defaultdict(int)
    for c in counts:
        if c.wastage_pieces:
            by_wastage[c.product.name] += c.wastage_pieces
        if c.remains_pieces:
            by_remains[c.product.name] += c.remains_pieces

    out = [f"Wastage & remains {start} to {end}:"]
    if by_wastage:
        out.append("Wastage (pieces thrown away):")
        for name, qty in sorted(by_wastage.items(), key=lambda x: -x[1]):
            out.append(f"  {name}: {qty} pcs")
    else:
        out.append("Wastage: none")
    if by_remains:
        out.append("Remains at close (unsold):")
        for name, qty in sorted(by_remains.items(), key=lambda x: -x[1]):
            out.append(f"  {name}: {qty} pcs")
    else:
        out.append("Remains: none")
    return "\n".join(out)


def _get_prep_log(inputs: dict, outlet_id) -> str:
    from stock.models import PreparationLog
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    qs = (
        PreparationLog.objects
        .filter(timestamp__date__range=(start, end))
        .select_related("product")
        .order_by("timestamp__date", "product__name")
    )
    if outlet_id:
        qs = qs.filter(outlet_id=outlet_id)
    logs = list(qs)
    if not logs:
        return f"No prep data for {start} to {end}."

    out = [f"Prep log {start} to {end}:"]
    by_day: dict[str, list] = defaultdict(list)
    for log in logs:
        d = log.timestamp.date().isoformat()
        src = "Fresh" if log.source == "FRESH" else "Carried fwd"
        wastage = f", wasted: {log.wastage_pieces}" if log.wastage_pieces else ""
        by_day[d].append(f"  {log.product.name}: {log.pieces_prepared} pcs ({src}{wastage})")
    for d, entries in sorted(by_day.items()):
        out.append(f"{d}:")
        out.extend(entries)
    return "\n".join(out)


def _get_stock_in_history(inputs: dict, outlet_id) -> str:
    from stock.models import StockInRecord
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    qs = (
        StockInRecord.objects
        .filter(stock_in_date__range=(start, end), status="APPROVED")
        .prefetch_related("items__ingredient")
        .order_by("stock_in_date")
    )
    if outlet_id:
        qs = qs.filter(outlet_id=outlet_id)
    records = list(qs)
    if not records:
        return f"No approved stock-in records for {start} to {end}."

    out = [f"Stock-in history {start} to {end}:"]
    for rec in records:
        out.append(f"{rec.stock_in_date}:")
        for item in rec.items.all():
            name = item.ingredient.name if item.ingredient else item.raw_extracted_text
            unit = item.ingredient.base_unit if item.ingredient else "unit"
            out.append(f"  {name}: {item.confirmed_quantity} {unit}")
    return "\n".join(out)


def _get_current_stock(inputs: dict, outlet_id) -> str:
    from django.utils import timezone
    today = timezone.localdate()
    out = []

    try:
        from stock.models import DisplayStock
        qs = DisplayStock.objects.filter(date=today).select_related("product")
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        stocks = list(qs)
        if stocks:
            out.append("Display stock (ready to sell):")
            for s in sorted(stocks, key=lambda x: x.product.name):
                out.append(f"  {s.product.name}: {s.available_pieces} pcs")
        else:
            out.append("No display stock recorded today.")
    except Exception as exc:
        out.append(f"Display stock unavailable: {exc}")

    try:
        from stock.models import RawStock
        qs = RawStock.objects.filter(date=today).select_related("ingredient")
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        raw = list(qs)
        if raw:
            out.append("Raw ingredient stock:")
            for r in sorted(raw, key=lambda x: x.ingredient.name):
                out.append(f"  {r.ingredient.name}: {r.quantity_available} {r.ingredient.base_unit}")
        else:
            out.append("No raw stock recorded today.")
    except Exception as exc:
        out.append(f"Raw stock unavailable: {exc}")

    return "\n".join(out) if out else "No stock data available."


def _get_expenses(inputs: dict, outlet_id) -> str:
    from costs.models import Expense
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    qs = (
        Expense.objects
        .filter(date__range=(start, end))
        .select_related("category")
        .order_by("date", "category__name")
    )
    if outlet_id:
        qs = qs.filter(outlet_id=outlet_id)
    expenses = list(qs)
    if not expenses:
        return f"No expenses for {start} to {end}."

    by_type: dict[str, list] = defaultdict(list)
    total = Decimal(0)
    for e in expenses:
        cost_type = e.category.cost_type if e.category else "ADHOC"
        by_type[cost_type].append(e)
        total += e.amount

    out = [f"Expenses {start} to {end}:"]
    for cost_type in ["FIXED", "VARIABLE", "ADHOC"]:
        if cost_type not in by_type:
            continue
        type_total = sum(e.amount for e in by_type[cost_type])
        out.append(f"{cost_type.capitalize()} ({_fmt(type_total)}):")
        for e in by_type[cost_type]:
            cat = e.category.name if e.category else "Uncategorized"
            out.append(f"  {e.date} — {cat}: {_fmt(e.amount)}")
    out.append(f"Total: {_fmt(total)}")
    return "\n".join(out)


def _get_operating_days(inputs: dict, outlet_id) -> str:
    from stock.models import OperatingDay
    start, end = _parse(inputs["start_date"]), _parse(inputs["end_date"])
    qs = OperatingDay.objects.filter(date__range=(start, end)).order_by("date")
    if outlet_id:
        qs = qs.filter(outlet_id=outlet_id)
    days = list(qs)
    if not days:
        return f"No operating days found for {start} to {end}."

    out = [f"Operating days {start} to {end}:"]
    for d in days:
        out.append(f"  {d.date} ({d.date.strftime('%a')}): {d.status}")
    return "\n".join(out)


# ── Dispatch table ────────────────────────────────────────────────────────────

_TOOL_FNS = {
    "get_pnl": _get_pnl,
    "get_sales_breakdown": _get_sales_breakdown,
    "get_wastage_breakdown": _get_wastage_breakdown,
    "get_prep_log": _get_prep_log,
    "get_stock_in_history": _get_stock_in_history,
    "get_current_stock": _get_current_stock,
    "get_expenses": _get_expenses,
    "get_operating_days": _get_operating_days,
}


def execute_tool(name: str, inputs: dict, outlet_id=None) -> str:
    fn = _TOOL_FNS.get(name)
    if fn is None:
        return f"Unknown tool: {name}"
    try:
        return fn(inputs, outlet_id)
    except Exception as exc:
        logger.error("Tool %s failed: %s", name, exc)
        return f"Error running {name}: {exc}"
