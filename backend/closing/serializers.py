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
    product_category = serializers.CharField(source="product.category", read_only=True)
    requires_preparation = serializers.BooleanField(source="product.requires_preparation", read_only=True)
    derived_walkin_sold = serializers.IntegerField(read_only=True)
    wastage_cost = serializers.SerializerMethodField()
    unit_price = serializers.SerializerMethodField()
    remains_value = serializers.SerializerMethodField()

    def _price(self, obj):
        from decimal import Decimal
        price_row = obj.product.active_price()
        return price_row.price if price_row else Decimal("0")

    def get_unit_price(self, obj):
        from decimal import Decimal
        return str(self._price(obj).quantize(Decimal("0.01")))

    def get_wastage_cost(self, obj):
        from decimal import Decimal
        if not obj.wastage_pieces:
            return "0.00"
        return str((self._price(obj) * obj.wastage_pieces).quantize(Decimal("0.01")))

    def get_remains_value(self, obj):
        from decimal import Decimal
        if not obj.remains_pieces:
            return "0.00"
        return str((self._price(obj) * obj.remains_pieces).quantize(Decimal("0.01")))

    def get_pieces_per_pack(self, obj):
        """Pack size of the product's first ingredient, for pack-breakdown display."""
        recipe = obj.product.recipes.select_related("ingredient").first()
        if not recipe:
            return None
        pack = recipe.ingredient.active_pack()
        if pack and pack.pieces_per_pack:
            return str(pack.pieces_per_pack)
        return None

    pieces_per_pack = serializers.SerializerMethodField()

    class Meta:
        model = DailyClosingStockCount
        fields = [
            "id", "product", "product_name", "product_category", "requires_preparation",
            "available_pieces", "wastage_pieces", "remains_pieces", "app_channel_sold",
            "derived_walkin_sold", "flag", "wastage_cost", "unit_price", "remains_value",
            "pieces_per_pack",
        ]
        read_only_fields = ["flag", "app_channel_sold", "derived_walkin_sold"]


class SalesLineSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = DailyClosingSalesLine
        fields = [
            "id", "product", "product_name", "channel", "channel_name",
            "quantity_sold", "unit_price", "gross_amount", "net_amount", "source",
        ]
        read_only_fields = ["gross_amount", "net_amount", "source"]


class ChannelDiscountSerializer(serializers.ModelSerializer):
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = DailyChannelDiscount
        fields = ["id", "channel", "channel_name", "discount_amount"]


class PaymentEntrySerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True)
    is_primary_cash = serializers.BooleanField(source="account.is_primary_cash", read_only=True)

    class Meta:
        model = PaymentEntry
        fields = ["id", "account", "account_name", "is_primary_cash", "amount"]


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
    carried_forward_value = serializers.SerializerMethodField()

    def get_carried_forward_value(self, obj):
        """Selling-price value of prepared items carried in from yesterday."""
        from decimal import Decimal
        from stock.models import PreparationLog, PrepSource
        total = Decimal("0")
        for log in PreparationLog.objects.filter(
            outlet=obj.outlet,
            op_date=obj.closing_date,
            source=PrepSource.CARRIED_FORWARD,
        ).select_related("product"):
            price_row = log.product.active_price()
            price = price_row.price if price_row else Decimal("0")
            total += price * log.pieces_prepared
        return str(total.quantize(Decimal("0.01")))

    class Meta:
        model = DailyClosing
        fields = [
            "id", "outlet", "closing_date", "staff", "staff_name", "status",
            "submitted_at", "stock_counts", "sales_lines", "channel_discounts",
            "payments", "total_sale", "channel_day_net_revenue", "online_payments",
            "total_offline_sales", "computed_cash", "has_flag", "carried_forward_value",
        ]
        read_only_fields = ["status", "submitted_at", "staff"]


class DailyClosingListSerializer(serializers.ModelSerializer):
    """Slim serializer for the closing list — no nested arrays, no N+1 CF query.
    Financial rollups come from model properties (require sales_lines / payments prefetch)."""

    staff_name = serializers.CharField(source="staff.name", read_only=True)
    total_sale = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    channel_day_net_revenue = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    computed_cash = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    has_flag = serializers.BooleanField(read_only=True)

    class Meta:
        model = DailyClosing
        fields = [
            "id", "outlet", "closing_date", "staff", "staff_name",
            "status", "submitted_at",
            "total_sale", "channel_day_net_revenue", "computed_cash", "has_flag",
        ]


class ChannelSettlementSerializer(serializers.ModelSerializer):
    channel_name = serializers.CharField(source="channel.name", read_only=True)

    class Meta:
        model = ChannelSettlement
        fields = [
            "id", "outlet", "channel", "channel_name", "period_start", "period_end",
            "expected_amount", "received_amount", "received_date", "status", "notes",
        ]
