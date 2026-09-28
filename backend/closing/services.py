"""Derivation logic for daily closing (walk-in sales + flags + app_channel_sold)."""
from collections import defaultdict
from decimal import Decimal

from sales.models import SalesChannel
from sales.pricing import resolve_price
from .models import DailyClosing, DailyClosingSalesLine, DailyClosingStockCount, LineSource, PaymentEntry


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

    # Fetch stock counts fresh, once, bypassing whatever prefetch cache `closing`
    # may be carrying. `closing` is typically fetched via a queryset that
    # prefetches `stock_counts` at the START of the request (see
    # DailyClosingViewSet.queryset) — if a caller (e.g. the stock-count action)
    # mutates and saves an individual DailyClosingStockCount row and THEN calls
    # this function in the same request, `closing.stock_counts.all()` would
    # transparently return that stale prefetched cache instead of hitting the
    # DB, silently recomputing (and re-persisting) the flag and the walk-in
    # revenue line from the pre-save values.
    counts = list(
        DailyClosingStockCount.objects.filter(daily_closing=closing).select_related("product")
    )

    # For DRAFT closings, keep available_pieces in sync with DisplayStock for prep
    # products. Non-prep products have their available_pieces set by the stock-count
    # step (day-start + stock-in formula) and their DisplayStock is set to `remains`
    # by _initialize_direct_stock — touching those would corrupt the formula.
    if closing.status == ClosingStatus.DRAFT:
        for count in counts:
            if not count.product.requires_preparation:
                continue
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
    for count in counts:
        count.app_channel_sold = app_sold.get(count.product_id, 0)
        count.recompute_flag()
        count.save(update_fields=["app_channel_sold", "flag"])

    if not walk_in:
        return

    # Rebuild SYSTEM_DERIVED Walk-in lines from current counts.
    closing.sales_lines.filter(
        channel=walk_in, source=LineSource.SYSTEM_DERIVED
    ).delete()
    for count in counts:
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


def sync_cash_payment_entry(closing):
    """Set the primary-cash PaymentEntry to the CURRENT computed_cash right
    before it's posted to the ledger. Without this, posting would use whatever
    amount the cash PaymentEntry last held — stale if the sales lines changed
    since (e.g. staff never revisited the Payments step, or a sell-correction
    edited yesterday's sale after the day was already locked) — silently
    corrupting the account's running balance by the gap.

    Re-fetches `closing` fresh so `computed_cash` (which reads sales_lines) is
    never computed against a stale prefetch cache the caller might be holding."""
    from finance.models import FinancialAccount

    primary_cash = (
        FinancialAccount.objects.filter(is_primary_cash=True).first()
        or FinancialAccount.objects.filter(account_type="CASH", is_active=True).first()
    )
    if not primary_cash:
        return
    closing_fresh = DailyClosing.objects.get(pk=closing.pk)
    cash_obj, _ = PaymentEntry.objects.get_or_create(
        daily_closing=closing_fresh, account=primary_cash
    )
    cash_obj.amount = closing_fresh.computed_cash
    cash_obj.save()


def record_account_transactions(closing, user):
    """Idempotently (re-)write SALES_COLLECTION transactions for each payment
    entry on this closing — voids whatever was posted before and re-posts from
    the current PaymentEntry amounts. Safe to call any number of times while
    the day is still being finalized (submit() re-running before the owner's
    lock(), or lock() itself re-syncing a flagged day) — at that point nothing
    has been reported as "settled" yet, so silently replacing the entry is
    just finishing a draft, not rewriting history.

    NOT used for post-lock corrections (see post_cash_correction below) — once
    a day is closed and time has passed, a later fix should never silently
    overwrite what was originally posted."""
    from finance import services as finance_services
    from finance.models import AccountTransaction, SourceType, TransactionType

    for t in AccountTransaction.objects.filter(
        source_type=SourceType.DAILY_CLOSING, source_id=closing.id,
    ):
        finance_services.void_transaction(t.id)
    for payment in closing.payments.select_related("account").filter(amount__gt=0):
        finance_services.post_transaction(
            account=payment.account, transaction_type=TransactionType.SALES_COLLECTION,
            amount=payment.amount, date=closing.closing_date, entered_by=user,
            source_type=SourceType.DAILY_CLOSING, source_id=closing.id,
            note=f"Day closing — {closing.closing_date}",
        )


def post_cash_correction(closing, user, note=""):
    """Reconcile the primary-cash account after a POST-LOCK correction (e.g.
    reports.views.correct_sells fixing a wrong sale on an already-closed day)
    — without rewriting what was originally posted.

    Unlike record_account_transactions, this never voids the original
    SALES_COLLECTION entry. It posts one standalone ADJUSTMENT transaction for
    just the delta, dated TODAY (not the closing date — the cash wasn't
    actually adjusted in the drawer back then, it's a paper correction made
    now), so the ledger reads as real bookkeeping: "Feb 10 closing: ৳500" and
    "Feb 12: sell correction −৳100" as two distinct, dated entries that net to
    the same corrected balance — never a single silently-edited ৳400.

    Returns the AccountTransaction posted, or None if there was nothing to
    correct (delta == 0, or no primary-cash account configured)."""
    from django.utils import timezone
    from finance import services as finance_services
    from finance.models import FinancialAccount, SourceType, TransactionType

    primary_cash = (
        FinancialAccount.objects.filter(is_primary_cash=True).first()
        or FinancialAccount.objects.filter(account_type="CASH", is_active=True).first()
    )
    if not primary_cash:
        return None

    closing_fresh = DailyClosing.objects.get(pk=closing.pk)
    cash_obj, _ = PaymentEntry.objects.get_or_create(
        daily_closing=closing_fresh, account=primary_cash
    )
    old_amount = cash_obj.amount
    new_amount = closing_fresh.computed_cash
    delta = new_amount - old_amount

    cash_obj.amount = new_amount
    cash_obj.save()

    if delta == 0:
        return None
    return finance_services.post_transaction(
        account=primary_cash, transaction_type=TransactionType.ADJUSTMENT,
        amount=delta, date=timezone.localdate(), entered_by=user,
        source_type=SourceType.DAILY_CLOSING, source_id=closing.id,
        note=note or f"Sell correction for {closing.closing_date} closing",
    )
