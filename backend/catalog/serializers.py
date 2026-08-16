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


class IngredientPickerSerializer(serializers.ModelSerializer):
    """Slim variant for picker dropdowns — no aliases, no tracking_mode/is_active.
    Used when the caller only needs id/name/unit/group and the active pack id.
    Request with ?slim=1 on the ingredient list endpoint."""

    active_pack = serializers.SerializerMethodField()

    class Meta:
        model = Ingredient
        fields = ["id", "name", "base_unit", "group", "active_pack"]

    def get_active_pack(self, obj):
        pack = obj.active_pack()
        if pack is None:
            return None
        return {"id": pack.id, "pieces_per_pack": str(pack.pieces_per_pack)}


class IngredientSerializer(serializers.ModelSerializer):
    active_pack = serializers.SerializerMethodField()
    aliases = SupplierProductAliasSerializer(many=True, read_only=True)

    class Meta:
        model = Ingredient
        fields = [
            "id", "name", "base_unit", "tracking_mode", "group", "is_active",
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


def _selling_price_from_prefetch(obj, as_of=None):
    """Compute selling_price from the prefetched `prices` relation (avoids N+1)."""
    from django.utils import timezone
    cache = getattr(obj, "_prefetched_objects_cache", {})
    if "prices" in cache:
        ref = as_of or timezone.localdate()
        candidates = [
            p for p in obj.prices.all()
            if p.effective_from <= ref and (p.effective_to is None or p.effective_to >= ref)
        ]
        if candidates:
            return str(max(candidates, key=lambda p: p.effective_from).price)
        return "0.00"
    active = obj.active_price(as_of=as_of)
    return str(active.price) if active else "0.00"


class ProductListSerializer(serializers.ModelSerializer):
    """Slim read-only serializer for the product list — no nested recipe/component arrays.
    Requires `prices` to be prefetched on the queryset for O(1) selling_price lookup."""

    selling_price = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = [
            "id", "name", "category", "product_type", "requires_preparation",
            "selling_price", "is_active",
        ]

    def get_selling_price(self, obj):
        as_of = self.context.get("as_of")
        cache = getattr(obj, "_prefetched_objects_cache", {})
        if "prices" in cache:
            from django.utils import timezone
            ref = as_of or timezone.localdate()
            candidates = [
                p for p in obj.prices.all()
                if p.effective_from <= ref and (p.effective_to is None or p.effective_to >= ref)
            ]
            if candidates:
                return str(max(candidates, key=lambda p: p.effective_from).price)
            return "0.00"
        active = obj.active_price(as_of=as_of)
        return str(active.price) if active else "0.00"


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


class PrepProductSerializer(serializers.ModelSerializer):
    """Slim read-only serializer for the prep log page (?prep=1).
    Server already filters: active SINGLE products that require preparation.
    Excludes combo components and active_price — not needed on the prep page."""

    recipes = RecipeSerializer(many=True, read_only=True)
    product_recipe_components = RecipeProductComponentSerializer(many=True, read_only=True)
    selling_price = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = [
            "id", "name", "category", "requires_preparation",
            "selling_price", "recipes", "product_recipe_components",
        ]

    def get_selling_price(self, obj):
        return _selling_price_from_prefetch(obj, self.context.get("as_of"))
