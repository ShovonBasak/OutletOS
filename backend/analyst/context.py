"""Build the system-prompt snapshot injected into every Claude analyst call.

All data is fetched read-only from the DB. Each section is wrapped in a
try/except so a missing table or bad query degrades gracefully rather than
blocking the whole response.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal

from django.utils import timezone

logger = logging.getLogger(__name__)

_Q = Decimal("0.01")


def _fmt(amount: Decimal | None) -> str:
    if amount is None:
        return "—"
    return f"৳{amount:,.0f}"


def build_system_prompt(outlet_id=None) -> str:
    today = timezone.localdate()
    yesterday = today - timedelta(days=1)
    week_start = today - timedelta(days=6)

    # Resolve outlet if owner's FK is None (single-outlet shop → use first outlet)
    if outlet_id is None:
        try:
            from catalog.models import Outlet
            first = Outlet.objects.filter(is_active=True).first()
            if first:
                outlet_id = first.id
        except Exception:
            pass

    sections: list[str] = [
        "You are the business analyst AI for CP Five Star, a fried chicken franchise outlet in Dhaka, Bangladesh.",
        "You have full read-only access to today's shop data shown below.",
        "Answer questions concisely and helpfully. Use ৳ for currency.",
        "Keep responses under 350 words — this is a WhatsApp chat interface.",
        f"Today: {today.strftime('%A, %d %B %Y')}",
        "",
    ]

    # ── Operating day ────────────────────────────────────────────────────────
    try:
        from stock.models import OperatingDay
        qs = OperatingDay.objects.filter(date=today)
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        op = qs.first()
        status = op.status if op else "NOT_STARTED"
        sections.append(f"OPERATING DAY STATUS: {status}")
    except Exception as exc:
        logger.warning("analyst context: operating day: %s", exc)

    # ── Today's sales ────────────────────────────────────────────────────────
    try:
        from closing.models import DailyClosingSalesLine
        qs = DailyClosingSalesLine.objects.filter(
            daily_closing__closing_date=today
        ).select_related("channel", "daily_closing")
        if outlet_id:
            qs = qs.filter(daily_closing__outlet_id=outlet_id)
        lines = list(qs)

        if lines:
            total_rev = sum(l.net_amount for l in lines)
            total_gross = sum(l.gross_amount for l in lines)
            total_units = sum(l.quantity_sold for l in lines)
            by_channel: dict[str, dict] = {}
            for l in lines:
                ch = l.channel.name
                entry = by_channel.setdefault(ch, {"rev": Decimal(0), "units": 0})
                entry["rev"] += l.net_amount
                entry["units"] += l.quantity_sold

            sections.append(f"\nTODAY'S SALES:")
            sections.append(f"  Net revenue:  {_fmt(total_rev)}")
            sections.append(f"  Gross revenue:{_fmt(total_gross)}")
            sections.append(f"  Units sold:   {total_units}")
            for ch, d in sorted(by_channel.items(), key=lambda x: -x[1]["rev"]):
                pct = d["rev"] / total_rev * 100 if total_rev else Decimal(0)
                sections.append(f"  {ch}: {_fmt(d['rev'])} ({pct:.0f}%) — {d['units']} units")
        else:
            sections.append("\nTODAY'S SALES: No sales recorded yet")
    except Exception as exc:
        logger.warning("analyst context: sales: %s", exc)

    # ── Today's closing summary ──────────────────────────────────────────────
    try:
        from closing.models import DailyClosing, DailyClosingStockCount
        qs = DailyClosing.objects.filter(closing_date=today)
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        closing = qs.select_related().first()
        if closing and closing.status != "DRAFT":
            sections.append(f"\nCLOSING STATUS: {closing.status}")
            counts = DailyClosingStockCount.objects.filter(
                daily_closing=closing
            ).select_related("product")
            wastage_total = sum(c.wastage_pieces for c in counts)
            remains_total = sum(c.remains_pieces for c in counts)
            sections.append(f"  Total wastage: {wastage_total} pieces")
            sections.append(f"  Total remains: {remains_total} pieces")
            if closing.has_variance_flag:
                sections.append("  ⚠ Variance flag — needs review")
    except Exception as exc:
        logger.warning("analyst context: closing: %s", exc)

    # ── Display stock (ready to sell) ────────────────────────────────────────
    try:
        from stock.models import DisplayStock
        qs = DisplayStock.objects.filter(date=today).select_related("product")
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        stocks = list(qs)
        if stocks:
            sections.append(f"\nDISPLAY STOCK (ready to sell):")
            for s in sorted(stocks, key=lambda x: x.product.name):
                sections.append(f"  {s.product.name}: {s.available_pieces} pcs")
    except Exception as exc:
        logger.warning("analyst context: display stock: %s", exc)

    # ── Raw stock (ingredient levels) ───────────────────────────────────────
    try:
        from stock.models import RawStock
        qs = RawStock.objects.filter(date=today).select_related("ingredient")
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        raw = list(qs)
        if raw:
            sections.append(f"\nRAW STOCK (ingredients as of today):")
            for r in sorted(raw, key=lambda x: x.ingredient.name):
                sections.append(
                    f"  {r.ingredient.name}: {r.quantity_available} {r.ingredient.base_unit}"
                )
    except Exception as exc:
        logger.warning("analyst context: raw stock: %s", exc)

    # ── Pending stock-in approvals ───────────────────────────────────────────
    try:
        from stock.models import StockInRecord
        qs = StockInRecord.objects.filter(status="PENDING")
        if outlet_id:
            qs = qs.filter(outlet_id=outlet_id)
        pending_count = qs.count()
        if pending_count:
            sections.append(f"\nPENDING APPROVALS: {pending_count} stock-in record(s) waiting for your approval")
    except Exception as exc:
        logger.warning("analyst context: stock-in pending: %s", exc)

    # ── Yesterday P&L ───────────────────────────────────────────────────────
    try:
        from reports.views import compute_pnl
        y_pnl = compute_pnl(yesterday, yesterday, outlet_id)
        sections.append(f"\nYESTERDAY ({yesterday.strftime('%d %b')}):")
        sections.append(f"  Revenue:    {_fmt(y_pnl['revenue'])}")
        sections.append(f"  COGS:       {_fmt(y_pnl['cogs'])}")
        sections.append(f"  Wastage:    {_fmt(y_pnl['wastage_cost'])}")
        sections.append(f"  Net profit: {_fmt(y_pnl['net_profit'])}")
    except Exception as exc:
        logger.warning("analyst context: yesterday P&L: %s", exc)

    # ── Last 7 days P&L ─────────────────────────────────────────────────────
    try:
        from reports.views import compute_pnl
        pnl = compute_pnl(week_start, today, outlet_id)
        sections.append(
            f"\nLAST 7 DAYS P&L ({week_start.strftime('%d %b')} – {today.strftime('%d %b')}):"
        )
        sections.append(f"  Revenue:        {_fmt(pnl['revenue'])}")
        sections.append(f"  COGS:           {_fmt(pnl['cogs'])}")
        sections.append(f"  Gross profit:   {_fmt(pnl['gross_profit'])}")
        sections.append(f"  Wastage:        {_fmt(pnl['wastage_cost'])}")
        sections.append(f"  Shrinkage:      {_fmt(pnl['shrinkage_cost'])}")
        sections.append(f"  Fixed costs:    {_fmt(pnl['fixed_costs'])}")
        sections.append(f"  Variable costs: {_fmt(pnl['variable_costs'])}")
        sections.append(f"  Adhoc costs:    {_fmt(pnl['adhoc_costs'])}")
        sections.append(f"  Other income:   {_fmt(pnl['other_income'])}")
        sections.append(f"  Net profit:     {_fmt(pnl['net_profit'])}")
        gp = pnl["gross_profit"]
        rev = pnl["revenue"]
        if rev:
            margin = gp / rev * 100
            sections.append(f"  Gross margin:   {margin:.1f}%")
    except Exception as exc:
        logger.warning("analyst context: 7-day P&L: %s", exc)

    # ── Day-start discrepancies ──────────────────────────────────────────────
    try:
        from stock.models import DayStartStockCheck
        qs = DayStartStockCheck.objects.filter(
            operating_day__date=today,
            discrepancy_qty__gt=0,
        ).select_related("ingredient", "operating_day")
        if outlet_id:
            qs = qs.filter(operating_day__outlet_id=outlet_id)
        discs = list(qs)
        if discs:
            sections.append(f"\nDAY-START DISCREPANCIES ({len(discs)}):")
            for d in discs:
                sections.append(
                    f"  {d.ingredient.name}: -{d.discrepancy_qty} {d.ingredient.base_unit}"
                    + (f" ({d.discrepancy_reason})" if d.discrepancy_reason else "")
                )
    except Exception as exc:
        logger.warning("analyst context: discrepancies: %s", exc)

    sections.append("\n— End of data snapshot —")
    return "\n".join(sections)
