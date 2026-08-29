"""Ingredient order quantity engine.

For a given delivery_date (ordered on order_date, typically today):

  pre_delivery  = [order_date+1 … delivery_date]
                  Stock already on hand covers these days; estimate consumption
                  and deduct it to get effective_stock at the moment of delivery.

  post_delivery = [delivery_date+1 … next_scheduled_delivery]
                  What the incoming order must cover (full days).

  required          = projected_post_delivery_usage × SAFETY_BUFFER
  effective_stock   = max(0, current_raw_stock − pre_delivery_estimated_use)
  to_order          = max(0, required − effective_stock)
  packs             = ⌈to_order ÷ pieces_per_pack⌉

Delivery schedule: Sunday (Python weekday 6), Tuesday (1), Thursday (3).
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


def _pre_delivery_period(order_date: date, delivery_date: date) -> list[date]:
    """Days from tomorrow through delivery_date.

    These days will consume existing stock before the delivery arrives.
    Example: order Friday → delivery Sunday → pre = [Sat, Sun].
    """
    result: list[date] = []
    d = order_date + timedelta(days=1)
    while d <= delivery_date:
        result.append(d)
        d += timedelta(days=1)
    return result


def _post_delivery_period(delivery_date: date) -> list[date]:
    """Days from the day after delivery through the next scheduled delivery (inclusive).

    These are the days the ordered stock must cover.
    Example: delivery Sunday → next delivery Tuesday → post = [Mon, Tue].
    """
    next_del = next_delivery_after(delivery_date)
    result: list[date] = []
    d = delivery_date + timedelta(days=1)
    while d <= next_del:
        result.append(d)
        d += timedelta(days=1)
    return result


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

        for r in product.recipes.all():
            by_day[d][r.ingredient_id] += qty * r.quantity_per_unit

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
    """week_num(1–5) → multiplier vs overall average daily usage."""
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
    days: list[date],
    weekday_avgs: dict[int, dict[int, Decimal]],
    fallback_avgs: dict[int, Decimal],
    week_multipliers: dict[int, Decimal],
) -> dict[int, Decimal]:
    """Total projected ingredient consumption across the given list of days."""
    projected: dict[int, Decimal] = defaultdict(Decimal)
    for d in days:
        wd = d.weekday()
        wk = _week_of_month(d)
        multiplier = Decimal(str(week_multipliers.get(wk, 1)))
        wd_data = weekday_avgs.get(wd, {})

        for ing_id in set(fallback_avgs):
            daily = wd_data.get(ing_id) or fallback_avgs.get(ing_id)
            if daily:
                projected[ing_id] += daily * multiplier

    return dict(projected)


# ── WhatsApp formatter ────────────────────────────────────────────────────────

def _format_whatsapp(
    suggestions: list[dict],
    delivery_date: date,
    pre_delivery: list[date],
    post_delivery: list[date],
) -> str:
    n_pre = len(pre_delivery)
    n_post = len(post_delivery)
    first_cover = post_delivery[0] if post_delivery else delivery_date + timedelta(days=1)
    last_cover = post_delivery[-1] if post_delivery else first_cover

    lines = [
        "📦 *ORDER SUGGESTION*",
        f"Delivery: {delivery_date.strftime('%A, %d %b %Y')}",
        f"Covers: {first_cover.strftime('%d %b')} – {last_cover.strftime('%d %b')} ({n_post} day{'s' if n_post > 1 else ''})",
    ]

    if n_pre > 0:
        pre_first = pre_delivery[0]
        pre_last = pre_delivery[-1]
        lines.append(
            f"_({n_pre} day{'s' if n_pre > 1 else ''} of stock "
            f"[{pre_first.strftime('%d %b')}–{pre_last.strftime('%d %b')}] "
            f"estimated to be used before delivery)_"
        )

    lines.extend(["", "*Ingredients to order:*"])

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

def compute_order_suggestion(
    delivery_date: date,
    outlet_id=None,
    order_date: date | None = None,
) -> dict:
    from catalog.models import Ingredient
    from stock.models import RawStock

    if order_date is None:
        order_date = date.today()

    pre_delivery = _pre_delivery_period(order_date, delivery_date)
    post_delivery = _post_delivery_period(delivery_date)
    next_del = next_delivery_after(delivery_date)
    n_pre = len(pre_delivery)
    n_post = len(post_delivery)

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

    # Project usage for both windows
    projected_pre = _project_usage(pre_delivery, weekday_avgs, fallback_avgs, week_multipliers)
    projected_post = _project_usage(post_delivery, weekday_avgs, fallback_avgs, week_multipliers)

    # Current raw stock
    raw_qs = RawStock.objects.select_related("ingredient")
    if outlet_id:
        raw_qs = raw_qs.filter(outlet_id=outlet_id)
    current_stock: dict[int, Decimal] = {r.ingredient_id: r.quantity_available for r in raw_qs}

    # All active RECIPE_LINKED ingredients used in at least one product that
    # requires preparation — excludes beverages and other direct-stock items.
    ingredients = {
        i.id: i
        for i in Ingredient.objects.filter(
            is_active=True,
            tracking_mode="RECIPE_LINKED",
            recipes__product__requires_preparation=True,
        ).distinct().prefetch_related("pack_definitions")
    }

    rows: list[dict] = []
    total_cost = Decimal(0)

    for ing_id, ing in ingredients.items():
        on_hand = current_stock.get(ing_id, Decimal(0))
        proj_post = projected_post.get(ing_id, Decimal(0))

        # Skip ingredients with no stock and no projected usage — nothing to show.
        if on_hand == 0 and proj_post == 0:
            continue

        pre_use = projected_pre.get(ing_id, Decimal(0))
        effective_stock = max(Decimal(0), on_hand - pre_use)

        required = (proj_post * SAFETY_BUFFER).quantize(Decimal("0.1"))
        to_order_raw = max(Decimal(0), required - effective_stock)

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

        needs_order = bool(
            (packs is not None and packs > 0) or (packs is None and to_order_raw > 0)
        )

        if needs_order and est_cost:
            total_cost += est_cost

        rows.append({
            "ingredient_id": ing_id,
            "ingredient_name": ing.name,
            "base_unit": ing.base_unit,
            "stock_on_hand": float(on_hand),
            "pre_delivery_estimated_use": float(pre_use.quantize(Decimal("0.1"))),
            "effective_stock_at_delivery": float(effective_stock.quantize(Decimal("0.1"))),
            "projected_usage": float(proj_post.quantize(Decimal("0.1"))),
            "required_with_buffer": float(required),
            "to_order_raw": float(to_order_raw.quantize(Decimal("0.1"))),
            "packs_to_order": packs if needs_order else 0,
            "pieces_per_pack": float(ppp) if ppp else None,
            "pieces_to_order": float(pieces_ordered.quantize(Decimal("0.1"))) if needs_order else 0,
            "cost_per_pack": float(cpp) if cpp else None,
            "estimated_cost": float(est_cost.quantize(Decimal("0.01"))) if (needs_order and est_cost) else None,
            "needs_order": needs_order,
        })

    # Sort: items needing order first (by projected usage desc), then sufficient stock (by name).
    suggestions = sorted(rows, key=lambda r: (not r["needs_order"], -r["projected_usage"]))

    whatsapp_text = _format_whatsapp(suggestions, delivery_date, pre_delivery, post_delivery)

    coverage_label = (
        f"{post_delivery[0].strftime('%a %d %b')} → "
        f"{post_delivery[-1].strftime('%a %d %b')} ({n_post} day{'s' if n_post > 1 else ''})"
    ) if post_delivery else ""

    pre_label = (
        f"{pre_delivery[0].strftime('%a %d %b')} → "
        f"{pre_delivery[-1].strftime('%a %d %b')} ({n_pre} day{'s' if n_pre > 1 else ''})"
    ) if pre_delivery else ""

    return {
        "delivery_date": delivery_date.isoformat(),
        "next_delivery_date": next_del.isoformat(),
        "pre_delivery_days": n_pre,
        "pre_delivery_label": pre_label,
        "days_to_cover": n_post,
        "coverage_label": coverage_label,
        "suggestions": suggestions,
        "total_estimated_cost": float(total_cost.quantize(Decimal("0.01"))),
        "whatsapp_text": whatsapp_text,
        "data_quality": {
            "history_days": HISTORY_DAYS,
            "operating_days_analyzed": operating_days_count,
            "confidence": confidence,
        },
    }
