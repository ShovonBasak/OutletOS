from django.contrib import admin

from .models import (
    ChannelIntegration,
    ChannelMenuMap,
    ChannelMenuMapItem,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


@admin.register(SalesChannel)
class SalesChannelAdmin(admin.ModelAdmin):
    list_display = [
        "name", "commission_rate", "settlement_type", "holding_account",
        "integration_type", "is_active",
    ]



admin.site.register(ChannelPromotion)
admin.site.register(OrderLevelOffer)
admin.site.register(ChannelIntegration)


class ChannelMenuMapItemInline(admin.TabularInline):
    model = ChannelMenuMapItem
    extra = 1


@admin.register(ChannelMenuMap)
class ChannelMenuMapAdmin(admin.ModelAdmin):
    list_display = ["external_name", "channel", "is_active"]
    list_filter = ["channel", "is_active"]
    search_fields = ["external_name", "items__product__name"]
    inlines = [ChannelMenuMapItemInline]
