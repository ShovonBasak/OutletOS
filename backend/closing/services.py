"""Derivation logic for daily closing (walk-in sales + flags + app_channel_sold)."""
from collections import defaultdict
from decimal import Decimal

from sales.models import SalesChannel
from sales.pricing import resolve_price
from .models import DailyClosingSalesLine, LineSource


def _walk_in_channel():
    return SalesChannel.objects.filter(name__iexact="Walk-in").first()


def recompute_closing(closing):
    """Re-derive app_channel_sold, flags, and the SYSTEM_DERIVED Walk-in lines.

    Idempotent: safe to call after each step (stock count, online sell). Walk-in
    quantity for each product = derived_walkin_sold when > 0.
    """
    from .models import ClosingStatus
    from stock.models import DisplayStock

    walk_in = _walk_in_channel()

    # For DRAFT closings, keep available_pieces in sync with DisplayStock for prep
    # products. Non-prep products have their available_pieces set by the stock-count
    # step (day-start + stock-in formula) and their DisplayStock is set to `remains`
    # by _initialize_direct_stock — touching those would corrupt the formula.
    if closing.status == ClosingStatus.DRAFT:
        for count in (
            closing.stock_counts
            .select_related("product")
            .filter(product__requires_preparation=True)
        ):
            ds = DisplayStock.objects.filter(
                outlet=closing.outlet, product=count.product
            ).first()
            if ds is not None and ds.pieces_available != count.available_pieces:
                count.available_pieces = ds.pieces_available
                count.save(update_fields=["available_pieces"])

    # Sum app-channel quantities (everything except Walk-in) per product.
    app_sold = defaultdict(int)
    for line in closing.sales_lines.select_related("channel").exclude(
        source=LineSource.SYSTEM_DERIVED
    ):
        if walk_in and line.channel_id == walk_in.id:
            continue
        app_sold[line.product_id] += line.quantity_sold

    # Update each stock count's app_channel_sold + flag.
    for count in closing.stock_counts.all():
        count.app_channel_sold = app_sold.get(count.product_id, 0)
        count.recompute_flag()
        count.save(update_fields=["app_channel_sold", "flag"])

    if not walk_in:
        return

    # Rebuild SYSTEM_DERIVED Walk-in lines from current counts.
    closing.sales_lines.filter(
        channel=walk_in, source=LineSource.SYSTEM_DERIVED
    ).delete()
    for count in closing.stock_counts.select_related("product"):
        qty = count.derived_walkin_sold
        if qty <= 0:
            continue
        price, _basis = resolve_price(count.product, walk_in, closing.closing_date)
        line = DailyClosingSalesLine(
            daily_closing=closing,
            product=count.product,
            channel=walk_in,
            quantity_sold=qty,
            unit_price=price,
            source=LineSource.SYSTEM_DERIVED,
        )
        line.recompute()
        line.save()
