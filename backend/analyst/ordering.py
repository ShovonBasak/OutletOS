"""Ingredient order quantity engine.

For a given delivery_date:
  coverage = delivery_date → day before the next scheduled delivery
  projected_usage = historical weighted average for each coverage day
                    × week-of-month multiplier
  required = projected_usage × SAFETY_BUFFER
  to_order = max(0, required − current_raw_stock)
  packs    = ⌈to_order ÷ pieces_per_pack⌉

Delivery schedule: Sunday (JS weekday 6), Tuesday (1), Thursday (3).
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

# Python date.weekday(): Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
DELIVERY_WEEKDAYS: frozenset[int] = frozenset({6, 1, 3})  # Sun, Tue, Thu
SAFETY_BUFFER = Decimal("1.15")
HISTORY_DAYS = 56  # 8 weeks of sales history


# ── Schedule helpers ──────────────────────────────────────────────────────────

def next_delivery_dates(from_date: date, n: int = 5) -> list[date]:
    """Return the next n delivery dates (Sun/Tue/Thu) on or after from_date."""
    results: list[date] = []
    d = from_date
    while len(results) < n:
        if d.weekday() in DELIVERY_WEEKDAYS:
            results.append(d)
        d += timedelta(days=1)
    return results


def next_delivery_after(d: date) -> date:
    """First scheduled delivery strictly after d."""
    nxt = d + timedelta(days=1)
    while nxt.weekday() not in DELIVERY_WEEKDAYS:
        nxt += timedelta(days=1)
    return nxt


def _coverage_period(delivery_date: date) -> list[date]:
    next_del = next_delivery_after(delivery_date)
    n = (next_del - delivery_date).days
    return [delivery_date + timedelta(days=i) for i in range(n)]


def _week_of_month(d: date) -> int:
    return (d.day - 1) // 7 + 1  # 1–5


# ── Historical data ───────────────────────────────────────────────────────────

def _ingredient_usage_by_day(outlet_id) -> dict[date, dict[int, Decimal]]:
    """Returns {sale_date: {ingredient_id: total_qty_consumed}} from last HISTORY_DAYS."""
    from closing.models import DailyClosingSalesLine

    today = date.today()
    history_start = today - timedelta(days=HISTORY_DAYS)

    qs = (
        DailyClosingSalesLine.objects.filter(
            daily_closing__closing_date__gte=history_start,
            daily_closing__closing_date__lte=today,
        )
        .select_related("daily_closing", "product")
        .prefetch_related(
            "product__recipes__ingredient",
            "product__components__component_product__recipes__ingredient",
        )
    )
    if outlet_id:
        qs = qs.filter(daily_closing__outlet_id=outlet_id)

    by_day: dict[date, dict[int, Decimal]] = defaultdict(lambda: defaultdict(Decimal))

    for line in qs:
        d = line.daily_closing.closing_date
        qty = Decimal(str(line.quantity_sold))
        product = line.product

        # Single product: direct recipe deductions
        for r in product.recipes.all():
            by_day[d][r.ingredient_id] += qty * r.quantity_per_unit

        # Combo: each component's recipe
        for comp in product.components.all():
            comp_qty = qty * Decimal(str(comp.quantity_per_combo))
            for r in comp.component_product.recipes.all():
                by_day[d][r.ingredient_id] += comp_qty * r.quantity_per_unit

    return dict(by_day)


# ── Pattern analysis ──────────────────────────────────────────────────────────

def _weekday_averages(
    by_day: dict[date, dict[int, Decimal]]
) -> dict[int, dict[int, Decimal]]:
    """weekday → {ingredient_id → mean daily usage on that weekday}"""
    buckets: dict[int, dict[int, list[Decimal]]] = defaultdict(lambda: defaultdict(list))
    for d, usage in by_day.items():
        wd = d.weekday()
        for ing_id, qty in usage.items():
            buckets[wd][ing_id].append(qty)

    return {
        wd: {ing_id: sum(vs) / len(vs) for ing_id, vs in ings.items()}
        for wd, ings in buckets.items()
    }


def _overall_day_averages(
    weekday_avgs: dict[int, dict[int, Decimal]]
) -> dict[int, Decimal]:
    """Fallback: mean across all weekdays for each ingredient."""
    acc: dict[int, list[Decimal]] = defaultdict(list)
    for wd_data in weekday_avgs.values():
        for ing_id, avg in wd_data.items():
            acc[ing_id].append(avg)
    return {ing_id: sum(vs) / len(vs) for ing_id, vs in acc.items()}


def _week_of_month_multipliers(
    by_day: dict[date, dict[int, Decimal]]
) -> dict[int, Decimal]:
    """week_num(1–5) → multiplier vs overall average daily revenue.
    Used to scale projections up/down for start/end of month behaviour."""
    week_totals: dict[int, list[Decimal]] = defaultdict(list)
    for d, usage in by_day.items():
        week_totals[_week_of_month(d)].append(sum(usage.values()))

    all_vals = [v for bucket in week_totals.values() for v in bucket]
    if not all_vals:
        return {}

    overall = sum(all_vals) / len(all_vals)
    if not overall:
        return {}

    return {
        wk: (sum(vals) / len(vals)) / overall
        for wk, vals in week_totals.items()
    }


# ── Projection ────────────────────────────────────────────────────────────────

def _project_usage(
    coverage: list[date],
    weekday_avgs: dict[int, dict[int, Decimal]],
    fallback_avgs: dict[int, Decimal],
    week_multipliers: dict[int, Decimal],
) -> dict[int, Decimal]:
    projected: dict[int, Decimal] = defaultdict(Decimal)
    for d in coverage:
        wd = d.weekday()
        wk = _week_of_month(d)
        multiplier = Decimal(str(week_multipliers.get(wk, 1)))
        wd_data = weekday_avgs.get(wd, {})

        all_ing_ids = set(fallback_avgs)

        for ing_id in all_ing_ids:
            daily = wd_data.get(ing_id) or fallback_avgs.get(ing_id)
            if daily:
                projected[ing_id] += daily * multiplier

    return dict(projected)


# ── WhatsApp formatter ────────────────────────────────────────────────────────

def _format_whatsapp(
    suggestions: list[dict],
    delivery_date: date,
    coverage: list[date],
) -> str:
    n_days = len(coverage)
    last_day = coverage[-1] if coverage else delivery_date

    lines = [
        "📦 *ORDER SUGGESTION*",
        f"Delivery: {delivery_date.strftime('%A, %d %b %Y')}",
        f"Covers: {delivery_date.strftime('%d %b')} – {last_day.strftime('%d %b')} ({n_days} day{'s' if n_days > 1 else ''})",
        "",
        "*Ingredients to order:*",
    ]

    total_cost = 0.0
    for s in suggestions:
        if s["packs_to_order"]:
            pieces = s["packs_to_order"] * (s["pieces_per_pack"] or 0)
            item = f"• {s['ingredient_name']}: {s['packs_to_order']} pack(s)"
            if pieces:
                item += f" ({int(pieces)} {s['base_unit']})"
            if s["estimated_cost"]:
                item += f" — ৳{s['estimated_cost']:,.0f}"
                total_cost += s["estimated_cost"]
        else:
            item = f"• {s['ingredient_name']}: {s['to_order_raw']:.1f} {s['base_unit']}"
        lines.append(item)

    if not suggestions:
        lines.append("✅ Stock levels look sufficient — no order needed.")
    else:
        if total_cost:
            lines.append(f"\n💰 *Estimated total: ৳{total_cost:,.0f}*")

    lines.append(f"\n_Based on {HISTORY_DAYS}-day history · 15% safety buffer_")
    return "\n".join(lines)


# ── Main entry point ──────────────────────────────────────────────────────────

def compute_order_suggestion(delivery_date: date, outlet_id=None) -> dict:
    from catalog.models import Ingredient
    from stock.models import RawStock

    today = date.today()
    coverage = _coverage_period(delivery_date)
    next_del = next_delivery_after(delivery_date)
    n_days = len(coverage)

    # Historical usage
    by_day = _ingredient_usage_by_day(outlet_id)
    operating_days_count = len(by_day)

    weekday_avgs = _weekday_averages(by_day)
    fallback_avgs = _overall_day_averages(weekday_avgs)
    week_multipliers = _week_of_month_multipliers(by_day)

    if operating_days_count >= 36:
        confidence = "High"
    elif operating_days_count >= 18:
        confidence = "Medium"
    else:
        confidence = "Low"

    projected = _project_usage(coverage, weekday_avgs, fallback_avgs, week_multipliers)

    # Current raw stock
    raw_qs = RawStock.objects.filter(date=today).select_related("ingredient")
    if outlet_id:
        raw_qs = raw_qs.filter(outlet_id=outlet_id)
    current_stock: dict[int, Decimal] = {r.ingredient_id: r.quantity_available for r in raw_qs}

    # Ingredient metadata
    ingredients = {
        i.id: i
        for i in Ingredient.objects.filter(
            id__in=set(projected), is_active=True, tracking_mode="RECIPE_LINKED"
        ).prefetch_related("pack_definitions")
    }

    suggestions: list[dict] = []
    total_cost = Decimal(0)

    for ing_id, proj in sorted(projected.items(), key=lambda x: -x[1]):
        ing = ingredients.get(ing_id)
        if not ing:
            continue

        on_hand = current_stock.get(ing_id, Decimal(0))
        required = (proj * SAFETY_BUFFER).quantize(Decimal("0.1"))
        to_order_raw = max(Decimal(0), required - on_hand)

        active_pack = ing.pack_definitions.filter(effective_to__isnull=True).first()
        ppp = active_pack.pieces_per_pack if active_pack else None
        cpp = active_pack.cost_per_pack if active_pack else None

        if ppp and ppp > 0:
            packs = math.ceil(float(to_order_raw) / float(ppp))
            pieces_ordered = Decimal(str(packs)) * ppp
            est_cost = Decimal(str(packs)) * cpp if cpp else None
        else:
            packs = None
            pieces_ordered = to_order_raw
            est_cost = None

        # Skip if genuinely no order needed
        if (packs is not None and packs == 0) or (packs is None and to_order_raw <= 0):
            continue

        if est_cost:
            total_cost += est_cost

        suggestions.append({
            "ingredient_id": ing_id,
            "ingredient_name": ing.name,
            "base_unit": ing.base_unit,
            "stock_on_hand": float(on_hand),
            "projected_usage": float(proj.quantize(Decimal("0.1"))),
            "required_with_buffer": float(required),
            "to_order_raw": float(to_order_raw.quantize(Decimal("0.1"))),
            "packs_to_order": packs,
            "pieces_per_pack": float(ppp) if ppp else None,
            "pieces_to_order": float(pieces_ordered.quantize(Decimal("0.1"))),
            "cost_per_pack": float(cpp) if cpp else None,
            "estimated_cost": float(est_cost.quantize(Decimal("0.01"))) if est_cost else None,
        })

    whatsapp_text = _format_whatsapp(suggestions, delivery_date, coverage)

    return {
        "delivery_date": delivery_date.isoformat(),
        "next_delivery_date": next_del.isoformat(),
        "days_to_cover": n_days,
        "coverage_label": (
            f"{delivery_date.strftime('%a %d %b')} → "
            f"{coverage[-1].strftime('%a %d %b')} ({n_days} day{'s' if n_days > 1 else ''})"
        ),
        "suggestions": suggestions,
        "total_estimated_cost": float(total_cost.quantize(Decimal("0.01"))),
        "whatsapp_text": whatsapp_text,
        "data_quality": {
            "history_days": HISTORY_DAYS,
            "operating_days_analyzed": operating_days_count,
            "confidence": confidence,
        },
    }
