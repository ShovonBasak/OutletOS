from rest_framework import serializers

from .models import (
    ChannelMenuMap,
    ChannelMenuMapItem,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


class SalesChannelSerializer(serializers.ModelSerializer):
    holding_account_name = serializers.CharField(
        source="holding_account.name", read_only=True, default=None
    )

    class Meta:
        model = SalesChannel
        fields = [
            "id", "name", "commission_rate", "settlement_type",
            "integration_type", "commission_basis",
            "holding_account", "holding_account_name", "is_active",
        ]


class SalesChannelSlimSerializer(serializers.ModelSerializer):
    """Slim read-only variant for picker/filter contexts (?slim=1).
    Omits commission and settlement fields — callers only need id/name/is_active."""

    class Meta:
        model = SalesChannel
        fields = ["id", "name", "is_active"]



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
