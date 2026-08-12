from django.contrib import admin

from .models import (
    ChannelIntegration,
    ChannelMenuMap,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


@admin.register(SalesChannel)
class SalesChannelAdmin(admin.ModelAdmin):
    list_display = ["name", "commission_rate", "settlement_type", "integration_type", "is_active"]



admin.site.register(ChannelPromotion)
admin.site.register(OrderLevelOffer)
admin.site.register(ChannelIntegration)


@admin.register(ChannelMenuMap)
class ChannelMenuMapAdmin(admin.ModelAdmin):
    list_display = ["external_name", "channel", "product", "quantity_multiplier", "is_active"]
    list_filter = ["channel", "is_active"]
    search_fields = ["external_name", "product__name"]
