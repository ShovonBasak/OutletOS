from rest_framework import serializers

from .models import (
    DayStartStockCheck,
    DisplayStock,
    OperatingDay,
    PeriodicStockCheck,
    PrepSource,
    PrepUnit,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
    UnitCaptured,
)


class StockInItemSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)
    pieces_per_pack = serializers.DecimalField(
        source="pack_definition.pieces_per_pack",
        max_digits=10, decimal_places=3, read_only=True,
    )
    base_unit_quantity = serializers.SerializerMethodField()
    is_unrecognized = serializers.SerializerMethodField()
    needs_pack_yield = serializers.SerializerMethodField()

    class Meta:
        model = StockInItem
        fields = [
            "id", "ingredient", "ingredient_name", "base_unit", "raw_extracted_text",
            "source", "unit_captured", "extracted_quantity", "confirmed_quantity",
            "pack_definition", "pieces_per_pack", "base_unit_quantity",
            "is_unrecognized", "needs_pack_yield",
        ]

    def get_base_unit_quantity(self, obj):
        return obj.base_unit_quantity()

    def get_is_unrecognized(self, obj):
        return obj.ingredient_id is None

    def get_needs_pack_yield(self, obj):
        return (
            obj.ingredient_id is not None
            and obj.unit_captured == UnitCaptured.PACK
            and obj.pack_definition_id is None
        )


class StockInRecordSerializer(serializers.ModelSerializer):
    items = StockInItemSerializer(many=True, required=False)
    submitted_by_name = serializers.CharField(source="submitted_by.name", read_only=True)
    unresolved_count = serializers.SerializerMethodField()

    class Meta:
        model = StockInRecord
        fields = [
            "id", "outlet", "stock_in_date", "submitted_by", "submitted_by_name",
            "status", "reviewed_by", "reviewed_at", "slip_image", "notes",
            "created_at", "items", "unresolved_count",
        ]
        # slip_image is set via the dedicated multipart upload-slip action.
        read_only_fields = [
            "status", "reviewed_by", "reviewed_at", "created_at",
            "submitted_by", "slip_image",
        ]

    def get_unresolved_count(self, obj):
        return len(obj.unresolved_lines)

    def create(self, validated_data):
        items = validated_data.pop("items", [])
        record = StockInRecord.objects.create(**validated_data)
        for item in items:
            StockInItem.objects.create(stock_in_record=record, **item)
        return record

    def update(self, instance, validated_data):
        items = validated_data.pop("items", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if items is not None:
            instance.items.all().delete()
            for item in items:
                StockInItem.objects.create(stock_in_record=instance, **item)
        return instance


class PreparationLogSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model = PreparationLog
        fields = [
            "id", "outlet", "logged_by", "product", "product_name", "timestamp",
            "source", "carried_forward_from", "leftover_available_pieces",
            "prep_unit", "packs_used", "pieces_prepared", "wastage_pieces",
        ]
        read_only_fields = ["timestamp", "logged_by", "wastage_pieces"]

    def validate(self, attrs):
        source = attrs.get("source", PrepSource.FRESH)
        if source == PrepSource.CARRIED_FORWARD:
            return attrs
        unit = attrs.get("prep_unit", PrepUnit.PIECE)
        if unit == PrepUnit.PACK and not attrs.get("packs_used"):
            raise serializers.ValidationError("packs_used is required for PACK entries.")
        if unit == PrepUnit.PIECE and not attrs.get("pieces_prepared"):
            raise serializers.ValidationError("pieces_prepared is required for PIECE entries.")
        return attrs


class RawStockSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)

    class Meta:
        model = RawStock
        fields = [
            "id", "outlet", "ingredient", "ingredient_name", "base_unit",
            "quantity_available",
        ]


class DisplayStockSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model = DisplayStock
        fields = ["id", "outlet", "product", "product_name", "pieces_available"]


class DayStartStockCheckSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)
    discrepancy_qty = serializers.DecimalField(
        max_digits=12, decimal_places=3, read_only=True
    )

    class Meta:
        model = DayStartStockCheck
        fields = [
            "id", "operating_day", "ingredient", "ingredient_name", "base_unit",
            "system_carried_qty", "confirmed_qty", "discrepancy_qty",
            "discrepancy_reason", "note",
        ]


class OperatingDaySerializer(serializers.ModelSerializer):
    stock_checks = DayStartStockCheckSerializer(many=True, read_only=True)
    stock_in_unlocked = serializers.BooleanField(read_only=True)
    full_unlocked = serializers.BooleanField(read_only=True)

    class Meta:
        model = OperatingDay
        fields = [
            "id", "outlet", "date", "status", "started_by", "started_at",
            "stock_confirmed_at", "carry_forward_confirmed_at", "daily_closing",
            "stock_in_unlocked", "full_unlocked", "stock_checks",
        ]


class PeriodicStockCheckSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)
    checked_by_name = serializers.CharField(source="checked_by.name", read_only=True)

    class Meta:
        model = PeriodicStockCheck
        fields = [
            "id", "outlet", "ingredient", "ingredient_name", "base_unit",
            "checked_at", "checked_by", "checked_by_name", "counted_qty",
            "stock_in_since_last_check", "consumed_since_last_check", "note",
        ]
        read_only_fields = [
            "checked_at", "checked_by", "stock_in_since_last_check",
            "consumed_since_last_check",
        ]
