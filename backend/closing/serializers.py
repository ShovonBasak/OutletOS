from rest_framework import serializers

from .models import (
    ChannelSettlement,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    PaymentEntry,
)


class StockCountSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    derived_walkin_sold = serializers.IntegerField(read_only=True)

    class Meta:
        model = DailyClosingStockCount
        fields = [
            "id", "product", "product_name", "available_pieces", "wastage_pieces",
            "remains_pieces", "app_channel_sold", "derived_walkin_sold", "flag",
        ]
        read_only_fields = ["flag", "app_channel_sold", "derived_walkin_sold"]


class SalesLineSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = DailyClosingSalesLine
        fields = [
            "id", "product", "product_name", "channel", "channel_name",
            "quantity_sold", "unit_price", "gross_amount", "commission_amount",
            "net_amount", "source",
        ]
        read_only_fields = ["gross_amount", "commission_amount", "net_amount", "source"]


class ChannelDiscountSerializer(serializers.ModelSerializer):
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = DailyChannelDiscount
        fields = ["id", "channel", "channel_name", "discount_amount", "note"]


class PaymentEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = PaymentEntry
        fields = ["id", "method", "amount"]


class DailyClosingSerializer(serializers.ModelSerializer):
    stock_counts = StockCountSerializer(many=True, read_only=True)
    sales_lines = SalesLineSerializer(many=True, read_only=True)
    channel_discounts = ChannelDiscountSerializer(many=True, read_only=True)
    payments = PaymentEntrySerializer(many=True, read_only=True)
    staff_name = serializers.CharField(source="staff.name", read_only=True)

    total_sale = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    channel_day_net_revenue = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    online_payments = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    total_offline_sales = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    computed_cash = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    has_flag = serializers.BooleanField(read_only=True)

    class Meta:
        model = DailyClosing
        fields = [
            "id", "outlet", "closing_date", "staff", "staff_name", "status",
            "submitted_at", "stock_counts", "sales_lines", "channel_discounts",
            "payments", "total_sale", "channel_day_net_revenue", "online_payments",
            "total_offline_sales", "computed_cash", "has_flag",
        ]
        read_only_fields = ["status", "submitted_at", "staff"]


class ChannelSettlementSerializer(serializers.ModelSerializer):
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = ChannelSettlement
        fields = [
            "id", "outlet", "channel", "channel_name", "period_start", "period_end",
            "expected_amount", "received_amount", "received_date", "status", "notes",
        ]
