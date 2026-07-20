from django.contrib import admin

from .models import (
    ChannelSettlement,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    PaymentEntry,
)


class StockCountInline(admin.TabularInline):
    model = DailyClosingStockCount
    extra = 0


class SalesLineInline(admin.TabularInline):
    model = DailyClosingSalesLine
    extra = 0


class PaymentInline(admin.TabularInline):
    model = PaymentEntry
    extra = 0


@admin.register(DailyClosing)
class DailyClosingAdmin(admin.ModelAdmin):
    list_display = ["closing_date", "outlet", "status", "staff"]
    list_filter = ["status", "outlet"]
    inlines = [StockCountInline, SalesLineInline, PaymentInline]


@admin.register(ChannelSettlement)
class ChannelSettlementAdmin(admin.ModelAdmin):
    list_display = ["channel", "period_start", "period_end", "expected_amount", "received_amount", "status"]
    list_filter = ["status", "channel"]


admin.site.register(DailyChannelDiscount)
