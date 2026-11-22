from rest_framework import serializers

from .models import (
    ChannelMenuMap,
    ChannelMenuMapItem,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


def _supports_excel_import(channel) -> bool:
    """Whether the Online sell page should offer an order-report upload for
    this channel — i.e. whether closing.excel_parser has a parser that
    understands that platform's export. Only Foodpanda's today; Pathao/Foodi
    get this automatically once a parser for their report format exists,
    without any further frontend changes (it no longer hardcodes a name
    check itself)."""
    return channel.name.strip().lower() == "foodpanda"


class SalesChannelSerializer(serializers.ModelSerializer):
    holding_account_name = serializers.CharField(
        source="holding_account.name", read_only=True, default=None
    )
    supports_excel_import = serializers.SerializerMethodField()

    class Meta:
        model = SalesChannel
        fields = [
            "id", "name", "commission_rate", "settlement_type",
            "integration_type", "commission_basis",
            "holding_account", "holding_account_name", "is_active",
            "supports_excel_import",
        ]

    def get_supports_excel_import(self, obj):
        return _supports_excel_import(obj)


class SalesChannelSlimSerializer(serializers.ModelSerializer):
    """Slim read-only variant for picker/filter contexts (?slim=1).
    Omits commission and settlement fields — callers only need id/name/is_active."""
    supports_excel_import = serializers.SerializerMethodField()

    class Meta:
        model = SalesChannel
        fields = ["id", "name", "is_active", "supports_excel_import"]

    def get_supports_excel_import(self, obj):
        return _supports_excel_import(obj)



class ChannelPromotionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChannelPromotion
        fields = [
            "id", "channel", "product", "discount_type", "value",
            "effective_from", "effective_to", "is_active",
        ]


class OrderLevelOfferSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrderLevelOffer
        fields = [
            "id", "channel", "description", "threshold_amount", "discount_type",
            "value", "effective_from", "effective_to", "is_active",
        ]


class ChannelMenuMapItemSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model = ChannelMenuMapItem
        fields = ["id", "menu_map", "product", "product_name", "quantity"]


class ChannelMenuMapSerializer(serializers.ModelSerializer):
    channel_name = serializers.CharField(source="channel.name", read_only=True)
    items = ChannelMenuMapItemSerializer(many=True, read_only=True)

    class Meta:
        model = ChannelMenuMap
        fields = ["id", "channel", "channel_name", "external_name", "items", "is_active"]
