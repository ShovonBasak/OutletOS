from decimal import Decimal

from django.db import models


class Outlet(models.Model):
    name = models.CharField(max_length=120)
    address = models.CharField(max_length=255, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class ProductType(models.TextChoices):
    SINGLE = "SINGLE", "Single"
    COMBO = "COMBO", "Combo"


class Product(models.Model):
    """The sellable/priced thing a customer orders. What's received and stocked
    is now an Ingredient (see below); a Product is linked to the ingredients it's
    made from via Recipe."""

    name = models.CharField(max_length=120)
    category = models.CharField(max_length=80, blank=True)
    product_type = models.CharField(
        max_length=10, choices=ProductType.choices, default=ProductType.SINGLE
    )
    # True for fried/prepared items that flow through PreparationLog; False for
    # items sold straight from stock (cold drinks, etc.).
    requires_preparation = models.BooleanField(default=True)
    selling_price = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["category", "name"]

    def __str__(self):
        return self.name


class ComboComponent(models.Model):
    """A COMBO is made of one or more SINGLE components; selling the combo
    decrements DisplayStock for each component by quantity_per_combo."""

    combo_product = models.ForeignKey(
        Product, on_delete=models.CASCADE, related_name="components",
        limit_choices_to={"product_type": ProductType.COMBO},
    )
    component_product = models.ForeignKey(
        Product, on_delete=models.CASCADE, related_name="in_combos",
        limit_choices_to={"product_type": ProductType.SINGLE},
    )
    quantity_per_combo = models.PositiveIntegerField(default=1)

    class Meta:
        unique_together = ("combo_product", "component_product")

    def __str__(self):
        return f"{self.combo_product} → {self.quantity_per_combo}× {self.component_product}"


class TrackingMode(models.TextChoices):
    RECIPE_LINKED = "RECIPE_LINKED", "Recipe-linked"
    PERIODIC_COUNT = "PERIODIC_COUNT", "Periodic count"


class Ingredient(models.Model):
    """The canonical, internal name for a raw material — one row per real-world
    thing you buy, regardless of what a supplier calls it. Stock (RawStock) and
    packs (PackDefinition) live here, not on Product."""

    name = models.CharField(max_length=120)
    # The countable unit recipes are written in — chosen for what's natural in a
    # recipe (e.g. "portion" for mayo, not "bottle"), so recipe lines stay whole.
    base_unit = models.CharField(max_length=30, default="piece")
    tracking_mode = models.CharField(
        max_length=15, choices=TrackingMode.choices, default=TrackingMode.RECIPE_LINKED
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    def active_pack(self):
        return self.pack_definitions.filter(effective_to__isnull=True).first()

    @property
    def cost_per_base_unit(self):
        pack = self.active_pack()
        if pack:
            return pack.cost_per_base_unit
        return Decimal("0")


class SupplierProductAlias(models.Model):
    """Solves the supplier naming-mismatch problem. OCR/manual entry matches
    against this table first; a resolved-once mapping is remembered here."""

    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="aliases"
    )
    alias_text = models.CharField(max_length=255)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["alias_text"]

    def __str__(self):
        return f"{self.alias_text} → {self.ingredient}"


class PackDefinition(models.Model):
    """Price-versioned pack size/cost per ingredient so history isn't rewritten
    on change. pieces_per_pack is in the ingredient's base_unit (e.g. 22 for a
    mayo bottle measured in portions)."""

    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.CASCADE, related_name="pack_definitions"
    )
    pieces_per_pack = models.DecimalField(max_digits=10, decimal_places=3)
    cost_per_pack = models.DecimalField(max_digits=10, decimal_places=2)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)  # null = currently active

    class Meta:
        ordering = ["-effective_from"]

    def __str__(self):
        return (
            f"{self.ingredient} — {self.pieces_per_pack} "
            f"{self.ingredient.base_unit}/pack @ ৳{self.cost_per_pack}"
        )

    @property
    def is_active(self):
        return self.effective_to is None

    @property
    def cost_per_base_unit(self):
        if not self.pieces_per_pack:
            return Decimal("0")
        return (self.cost_per_pack / self.pieces_per_pack).quantize(Decimal("0.0001"))


class Recipe(models.Model):
    """Bill of materials: links a sellable Product to the Ingredient(s) it's made
    from and how much of each one unit consumes. Every Product has at least one
    Recipe row (a direct-stock item like a cold drink has one at qty 1)."""

    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="recipes")
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.PROTECT, related_name="recipes"
    )
    # How many of the ingredient's base_unit are consumed per 1 unit of product.
    quantity_per_unit = models.DecimalField(max_digits=10, decimal_places=3, default=1)

    class Meta:
        unique_together = ("product", "ingredient")
        ordering = ["id"]

    def __str__(self):
        return f"{self.product} ← {self.quantity_per_unit} {self.ingredient.base_unit} {self.ingredient}"
