from rest_framework import serializers

from .models import (
    ComboComponent,
    Ingredient,
    Outlet,
    PackDefinition,
    Product,
    Recipe,
    SupplierProductAlias,
)


class OutletSerializer(serializers.ModelSerializer):
    class Meta:
        model = Outlet
        fields = ["id", "name", "address", "is_active"]


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
            "quantity_per_unit",
        ]


class ProductSerializer(serializers.ModelSerializer):
    components = ComboComponentSerializer(many=True, read_only=True)
    recipes = RecipeSerializer(many=True, read_only=True)

    class Meta:
        model = Product
        fields = [
            "id", "name", "category", "product_type", "requires_preparation",
            "selling_price", "is_active", "components", "recipes",
        ]
