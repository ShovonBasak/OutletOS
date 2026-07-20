from django.contrib import admin

from .models import (
    ChannelIntegration,
    ChannelPrice,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


@admin.register(SalesChannel)
class SalesChannelAdmin(admin.ModelAdmin):
    list_display = ["name", "commission_rate", "settlement_type", "integration_type", "is_active"]


@admin.register(ChannelPrice)
class ChannelPriceAdmin(admin.ModelAdmin):
    list_display = ["product", "channel", "price", "effective_from", "effective_to", "is_active"]
    list_filter = ["channel", "is_active"]


admin.site.register(ChannelPromotion)
admin.site.register(OrderLevelOffer)
admin.site.register(ChannelIntegration)
