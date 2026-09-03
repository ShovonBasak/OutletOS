from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.contrib import admin
from django.contrib.admin.views.decorators import staff_member_required
from django.db.models import Sum
from django.shortcuts import render
from django.urls import path

from catalog.models import Product
from stock.models import RawStock

from .models import (
    ChannelSettlement,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    PaymentEntry,
)

OUTLET_ID = 1


def _remaining_stock(product: Product) -> int | None:
    """Return how many units of this product can still be made from RawStock."""
    recipes = list(product.recipes.select_related("ingredient").all())
    if not recipes:
        return None
    minimum = None
    for r in recipes:
        rs = RawStock.objects.filter(outlet_id=OUTLET_ID, ingredient=r.ingredient).first()
        qty = rs.quantity_available if rs else Decimal("0")
        if r.quantity_per_unit and r.quantity_per_unit > 0:
            available = int(qty / r.quantity_per_unit)
        else:
            available = int(qty)
        minimum = available if minimum is None else min(minimum, available)
    return minimum


@staff_member_required
def sell_history_view(request):
    today = date.today()
    default_from = today - timedelta(days=29)

    raw_from = request.GET.get("from_date", "")
    raw_to   = request.GET.get("to_date", "")

    try:
        from_date = date.fromisoformat(raw_from) if raw_from else default_from
    except ValueError:
        from_date = default_from
    try:
        to_date = date.fromisoformat(raw_to) if raw_to else today
    except ValueError:
        to_date = today

    if from_date > to_date:
        from_date, to_date = to_date, from_date

    # Query all sales lines in the period
    lines = (
        DailyClosingSalesLine.objects
        .filter(
            daily_closing__outlet_id=OUTLET_ID,
            daily_closing__closing_date__range=(from_date, to_date),
        )
        .values("daily_closing__closing_date", "product_id", "product__name")
        .annotate(qty=Sum("quantity_sold"))
        .order_by("product__name", "daily_closing__closing_date")
    )

    # Build lookup: {product_id: {date: qty}}
    sales: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    product_names: dict[int, str] = {}
    dates_set: set[date] = set()

    for row in lines:
        pid  = row["product_id"]
        d    = row["daily_closing__closing_date"]
        qty  = row["qty"] or 0
        sales[pid][d] += qty
        product_names[pid] = row["product__name"]
        dates_set.add(d)

    sorted_dates = sorted(dates_set)
    sorted_pids  = sorted(product_names, key=lambda p: product_names[p])

    # Build product objects for stock lookup (bulk fetch)
    products_qs = {
        p.id: p for p in
        Product.objects.prefetch_related("recipes__ingredient").filter(id__in=sorted_pids)
    }

    rows = []
    date_totals = defaultdict(int)
    grand_total = 0

    for pid in sorted_pids:
        daily = [sales[pid].get(d, 0) for d in sorted_dates]
        row_total = sum(daily)
        for d, v in zip(sorted_dates, daily):
            date_totals[d] += v
        grand_total += row_total
        product = products_qs.get(pid)
        stock = _remaining_stock(product) if product else None
        rows.append({
            "name":  product_names[pid],
            "daily": daily,
            "total": row_total,
            "stock": stock,
        })

    context = {
        **admin.site.each_context(request),
        "title":       "Sell History",
        "from_date":   from_date.isoformat(),
        "to_date":     to_date.isoformat(),
        "dates":       sorted_dates,
        "rows":        rows,
        "date_totals": [date_totals[d] for d in sorted_dates],
        "grand_total": grand_total,
        "products":    rows,
        "opts":        DailyClosing._meta,
    }
    return render(request, "admin/closing/sell_history.html", context)


class StockCountInline(admin.TabularInline):
    model = DailyClosingStockCount
    extra = 0


class SalesLineInline(admin.TabularInline):
    model = DailyClosingSalesLine
    extra = 0


class PaymentInline(admin.TabularInline):
    model = PaymentEntry
    extra = 0


def reopen_day(modeladmin, request, queryset):
    """Reopen a LOCKED or SUBMITTED closing: reverses transactions, restores
    DisplayStock, and sets both DailyClosing and OperatingDay back to editable."""
    from finance.models import AccountTransaction, SourceType
    from stock.models import DisplayStock, OperatingDay, OperatingDayStatus
    from .models import ClosingStatus

    reopened = 0
    skipped = 0
    for closing in queryset.prefetch_related("stock_counts__product"):
        if closing.status == ClosingStatus.DRAFT:
            skipped += 1
            continue

        AccountTransaction.objects.filter(
            source_type=SourceType.DAILY_CLOSING,
            source_id=closing.id,
        ).delete()

        for count in closing.stock_counts.all():
            restore = count.available_pieces - count.remains_pieces
            if restore > 0:
                DisplayStock.adjust(closing.outlet, count.product, restore)

        OperatingDay.objects.filter(
            outlet=closing.outlet,
            date=closing.closing_date,
        ).update(status=OperatingDayStatus.IN_PROGRESS)

        closing.status = ClosingStatus.DRAFT
        closing.submitted_at = None
        closing.has_variance_flag = False
        closing.save()
        reopened += 1

    msg = f"{reopened} closing(s) reopened."
    if skipped:
        msg += f" {skipped} skipped (already DRAFT)."
    modeladmin.message_user(request, msg)


reopen_day.short_description = "Reopen selected day(s) for corrections"


@admin.register(DailyClosing)
class DailyClosingAdmin(admin.ModelAdmin):
    list_display = ["closing_date", "outlet", "status", "staff"]
    list_filter  = ["status", "outlet"]
    inlines      = [StockCountInline, SalesLineInline, PaymentInline]
    actions      = [reopen_day]

    def get_urls(self):
        urls = super().get_urls()
        custom = [
            path(
                "sell-history/",
                self.admin_site.admin_view(sell_history_view),
                name="closing_dailyclosing_sell_history",
            ),
        ]
        return custom + urls

    def changelist_view(self, request, extra_context=None):
        extra_context = extra_context or {}
        extra_context["sell_history_url"] = "sell-history/"
        return super().changelist_view(request, extra_context=extra_context)


@admin.register(ChannelSettlement)
class ChannelSettlementAdmin(admin.ModelAdmin):
    list_display = ["channel", "period_start", "period_end", "expected_amount", "received_amount", "status"]
    list_filter = ["status", "channel"]


admin.site.register(DailyChannelDiscount)
