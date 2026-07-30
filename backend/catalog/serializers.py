from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from .models import (
    ComboComponent,
    Ingredient,
    Outlet,
    PackDefinition,
    Product,
    ProductPrice,
    Recipe,
    RecipeProductComponent,
    SupplierProductAlias,
)


class OutletSerializer(serializers.ModelSerializer):
    class Meta:
        model = Outlet
        fields = ["id", "name", "address", "is_active", "allow_staff_date_selection"]


class ComboComponentSerializer(serializers.ModelSerializer):
    component_name = serializers.CharField(source="component_product.name", read_only=True)

    class Meta:
        model = ComboComponent
        fields = [
            "id", "combo_product", "component_product", "component_name", "quantity_per_combo",
        ]


class PackDefinitionSerializer(serializers.ModelSerializer):
    is_active = serializers.BooleanField(read_only=True)
    cost_per_base_unit = serializers.DecimalField(
        max_digits=10, decimal_places=4, read_only=True
    )
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)

    class Meta:
        model = PackDefinition
        fields = [
            "id", "ingredient", "base_unit", "pieces_per_pack", "cost_per_pack",
            "cost_per_base_unit", "effective_from", "effective_to", "is_active",
        ]


class SupplierProductAliasSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)

    class Meta:
        model = SupplierProductAlias
        fields = ["id", "ingredient", "ingredient_name", "alias_text", "is_active"]


class IngredientSerializer(serializers.ModelSerializer):
    active_pack = serializers.SerializerMethodField()
    aliases = SupplierProductAliasSerializer(many=True, read_only=True)

    class Meta:
        model = Ingredient
        fields = [
            "id", "name", "base_unit", "tracking_mode", "is_active",
            "active_pack", "aliases",
        ]

    def get_active_pack(self, obj):
        pack = obj.active_pack()
        return PackDefinitionSerializer(pack).data if pack else None


class RecipeSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source="ingredient.name", read_only=True)
    base_unit = serializers.CharField(source="ingredient.base_unit", read_only=True)

    class Meta:
        model = Recipe
        fields = [
            "id", "product", "ingredient", "ingredient_name", "base_unit",
            "quantity_per_unit", "is_primary",
        ]


class RecipeProductComponentSerializer(serializers.ModelSerializer):
    component_name = serializers.CharField(source="component_product.name", read_only=True)

    class Meta:
        model = RecipeProductComponent
        fields = [
            "id", "product", "component_product", "component_name", "quantity_per_unit",
        ]


class ProductPriceSerializer(serializers.ModelSerializer):
    is_active = serializers.BooleanField(read_only=True)
    changed_by_name = serializers.CharField(
        source="changed_by.name", read_only=True, default=None
    )

    class Meta:
        model = ProductPrice
        fields = [
            "id", "product", "price", "effective_from", "effective_to",
            "changed_by", "changed_by_name", "note", "is_active",
        ]
        read_only_fields = ["changed_by"]


class ProductSerializer(serializers.ModelSerializer):
    components = ComboComponentSerializer(many=True, read_only=True)
    recipes = RecipeSerializer(many=True, read_only=True)
    product_recipe_components = RecipeProductComponentSerializer(many=True, read_only=True)

    # Write-only on create/import — creates the initial ProductPrice row.
    # Use the set-price action to schedule a future price change.
    selling_price = serializers.DecimalField(
        max_digits=10, decimal_places=2,
        write_only=True, required=False, allow_null=True,
    )

    class Meta:
        model = Product
        fields = [
            "id", "name", "category", "product_type", "requires_preparation",
            "selling_price",     # write-only (create / import)
            "is_active", "components", "recipes", "product_recipe_components",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        as_of = self.context.get("as_of")
        active = instance.active_price(as_of=as_of)
        data["selling_price"] = str(active.price) if active else "0.00"
        data["active_price"] = ProductPriceSerializer(active).data if active else None
        return data

    def create(self, validated_data):
        selling_price = validated_data.pop("selling_price", None)
        effective_from = validated_data.pop("effective_from", None) or timezone.localdate()
        product = Product.objects.create(**validated_data)
        if selling_price is not None:
            user = self.context.get("request") and self.context["request"].user or None
            ProductPrice.objects.create(
                product=product,
                price=selling_price,
                effective_from=effective_from,
                changed_by=user if user and user.is_authenticated else None,
            )
        return product

    def update(self, instance, validated_data):
        # Price changes must go through the set-price action — ignore selling_price on PATCH/PUT.
        validated_data.pop("selling_price", None)
        validated_data.pop("effective_from", None)
        return super().update(instance, validated_data)
