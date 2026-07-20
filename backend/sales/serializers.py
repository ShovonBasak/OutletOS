from rest_framework import serializers

from .models import (
    ChannelPrice,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)


class SalesChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = SalesChannel
        fields = [
            "id", "name", "commission_rate", "settlement_type",
            "integration_type", "commission_basis", "is_active",
        ]


class ChannelPriceSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = ChannelPrice
        fields = [
            "id", "channel", "channel_name", "product", "product_name",
            "price", "effective_from", "effective_to", "is_active",
        ]


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
