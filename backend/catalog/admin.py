from django.contrib import admin

from .models import (
    ComboComponent,
    Ingredient,
    Organization,
    Outlet,
    PackDefinition,
    Product,
    ProductPrice,
    Recipe,
    RecipeProductComponent,
    SupplierProductAlias,
)


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "is_active", "created_at"]
    search_fields = ["name", "slug"]
    prepopulated_fields = {"slug": ("name",)}


class ComboComponentInline(admin.TabularInline):
    model = ComboComponent
    fk_name = "combo_product"
    extra = 1


class RecipeInline(admin.TabularInline):
    model = Recipe
    extra = 1


class RecipeProductComponentInline(admin.TabularInline):
    model = RecipeProductComponent
    fk_name = "product"
    extra = 1
    verbose_name = "Prepared product input"
    verbose_name_plural = "Prepared product inputs"


class PackDefinitionInline(admin.TabularInline):
    model = PackDefinition
    extra = 0


class ProductPriceInline(admin.TabularInline):
    model = ProductPrice
    extra = 0
    readonly_fields = ["is_active"]
    fields = ["price", "effective_from", "effective_to", "changed_by", "note", "is_active"]


class SupplierProductAliasInline(admin.TabularInline):
    model = SupplierProductAlias
    extra = 1


@admin.register(Outlet)
class OutletAdmin(admin.ModelAdmin):
    list_display = ["name", "organization", "address", "is_active"]
    list_filter = ["organization"]


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = [
        "name", "organization", "category", "product_type", "requires_preparation",
        "current_price", "is_active",
    ]
    list_filter = ["organization", "product_type", "requires_preparation", "is_active", "category"]
    search_fields = ["name"]
    inlines = [ProductPriceInline, RecipeInline, RecipeProductComponentInline, ComboComponentInline]

    @admin.display(description="Selling price")
    def current_price(self, obj):
        p = obj.active_price()
        return f"৳{p.price}" if p else "—"


@admin.register(ProductPrice)
class ProductPriceAdmin(admin.ModelAdmin):
    list_display = ["product", "price", "effective_from", "effective_to", "changed_by", "is_active"]
    list_filter = ["product"]
    readonly_fields = ["is_active"]


@admin.register(Ingredient)
class IngredientAdmin(admin.ModelAdmin):
    list_display = ["name", "organization", "base_unit", "tracking_mode", "is_active"]
    list_filter = ["organization", "tracking_mode", "is_active"]
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
