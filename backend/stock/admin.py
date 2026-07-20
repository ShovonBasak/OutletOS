from django.contrib import admin

from .models import (
    DayStartStockCheck,
    DisplayStock,
    OperatingDay,
    PeriodicStockCheck,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
)


class StockInItemInline(admin.TabularInline):
    model = StockInItem
    extra = 0


@admin.register(StockInRecord)
class StockInRecordAdmin(admin.ModelAdmin):
    list_display = ["id", "outlet", "stock_in_date", "status", "submitted_by"]
    list_filter = ["status", "outlet"]
    inlines = [StockInItemInline]


@admin.register(PreparationLog)
class PreparationLogAdmin(admin.ModelAdmin):
    list_display = [
        "product", "outlet", "source", "prep_unit", "packs_used",
        "pieces_prepared", "wastage_pieces", "timestamp",
    ]
    list_filter = ["outlet", "source", "prep_unit"]


class DayStartStockCheckInline(admin.TabularInline):
    model = DayStartStockCheck
    extra = 0


@admin.register(OperatingDay)
class OperatingDayAdmin(admin.ModelAdmin):
    list_display = ["date", "outlet", "status", "started_by"]
    list_filter = ["status", "outlet"]
    inlines = [DayStartStockCheckInline]


@admin.register(PeriodicStockCheck)
class PeriodicStockCheckAdmin(admin.ModelAdmin):
    list_display = [
        "ingredient", "outlet", "counted_qty", "consumed_since_last_check", "checked_at",
    ]
    list_filter = ["outlet", "ingredient"]


admin.site.register(RawStock)
admin.site.register(DisplayStock)
