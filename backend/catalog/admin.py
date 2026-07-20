from django.contrib import admin

from .models import (
    ComboComponent,
    Ingredient,
    Outlet,
    PackDefinition,
    Product,
    Recipe,
    SupplierProductAlias,
)


class ComboComponentInline(admin.TabularInline):
    model = ComboComponent
    fk_name = "combo_product"
    extra = 1


class RecipeInline(admin.TabularInline):
    model = Recipe
    extra = 1


class PackDefinitionInline(admin.TabularInline):
    model = PackDefinition
    extra = 0


class SupplierProductAliasInline(admin.TabularInline):
    model = SupplierProductAlias
    extra = 1


@admin.register(Outlet)
class OutletAdmin(admin.ModelAdmin):
    list_display = ["name", "address", "is_active"]


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = [
        "name", "category", "product_type", "requires_preparation",
        "selling_price", "is_active",
    ]
    list_filter = ["product_type", "requires_preparation", "is_active", "category"]
    search_fields = ["name"]
    inlines = [RecipeInline, ComboComponentInline]


@admin.register(Ingredient)
class IngredientAdmin(admin.ModelAdmin):
    list_display = ["name", "base_unit", "tracking_mode", "is_active"]
    list_filter = ["tracking_mode", "is_active"]
    search_fields = ["name"]
    inlines = [PackDefinitionInline, SupplierProductAliasInline]


@admin.register(PackDefinition)
class PackDefinitionAdmin(admin.ModelAdmin):
    list_display = [
        "ingredient", "pieces_per_pack", "cost_per_pack", "effective_from", "effective_to",
    ]
    list_filter = ["ingredient"]


admin.site.register(SupplierProductAlias)
admin.site.register(Recipe)
