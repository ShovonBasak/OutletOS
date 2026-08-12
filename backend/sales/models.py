from django.db import models

from catalog.models import Product


class SettlementType(models.TextChoices):
    DIRECT_TO_ACCOUNT = "DIRECT_TO_ACCOUNT", "Direct to account"
    COLLECTED_AT_OUTLET = "COLLECTED_AT_OUTLET", "Collected at outlet"


class IntegrationType(models.TextChoices):
    API_SYNC = "API_SYNC", "API sync"
    MANUAL = "MANUAL", "Manual"


class CommissionBasis(models.TextChoices):
    DISCOUNTED_PRICE = "DISCOUNTED_PRICE", "Discounted price"
    ORIGINAL_PRICE = "ORIGINAL_PRICE", "Original price"


class SalesChannel(models.Model):
    name = models.CharField(max_length=60)
    commission_rate = models.DecimalField(max_digits=5, decimal_places=4, default=0)  # 0.20 = 20%
    settlement_type = models.CharField(
        max_length=20, choices=SettlementType.choices,
        default=SettlementType.COLLECTED_AT_OUTLET,
    )
    integration_type = models.CharField(
        max_length=10, choices=IntegrationType.choices, default=IntegrationType.MANUAL
    )
    # Confirm per-platform whether commission is on discounted or original price.
    commission_basis = models.CharField(
        max_length=20, choices=CommissionBasis.choices,
        default=CommissionBasis.DISCOUNTED_PRICE,
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    @property
    def is_walk_in(self):
        return self.name.lower() in ("walk-in", "walkin", "walk in", "counter")


class ChannelIntegration(models.Model):
    """Connection state for API_SYNC channels. Unused in v1 (table stays empty)."""

    channel = models.OneToOneField(
        SalesChannel, on_delete=models.CASCADE, related_name="integration"
    )
    connected = models.BooleanField(default=False)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    credentials = models.JSONField(default=dict, blank=True)

    def __str__(self):
        return f"Integration for {self.channel}"



class DiscountType(models.TextChoices):
    PERCENTAGE = "PERCENTAGE", "Percentage"
    FIXED_AMOUNT = "FIXED_AMOUNT", "Fixed amount"


class ChannelPromotion(models.Model):
    """Simple ongoing discount on regular (non-combo) items."""

    channel = models.ForeignKey(
        SalesChannel, null=True, blank=True, on_delete=models.CASCADE, related_name="promotions"
    )  # null = all channels
    product = models.ForeignKey(
        Product, null=True, blank=True, on_delete=models.CASCADE, related_name="promotions"
    )  # null = all products
    discount_type = models.CharField(max_length=12, choices=DiscountType.choices)
    value = models.DecimalField(max_digits=10, decimal_places=2)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-effective_from", "id"]

    def __str__(self):
        return f"Promo {self.discount_type} {self.value}"


class OrderLevelOffer(models.Model):
    """Reference-only. Threshold deals can't be computed from daily aggregates."""

    channel = models.ForeignKey(
        SalesChannel, null=True, blank=True, on_delete=models.CASCADE, related_name="order_offers"
    )
    description = models.CharField(max_length=255)
    threshold_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    discount_type = models.CharField(max_length=12, choices=DiscountType.choices)
    value = models.DecimalField(max_digits=10, decimal_places=2)
    effective_from = models.DateField()
    effective_to = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-effective_from", "id"]

    def __str__(self):
        return self.description


class ChannelMenuMap(models.Model):
    """Maps an online platform's item name to an internal product with a quantity multiplier.

    e.g. "3X Hot & Crispy Chicken" → product=Hot & Crispy Chicken, multiplier=3
         "Crispy Chicken"          → product=Hot & Crispy Chicken, multiplier=1
    """

    channel = models.ForeignKey(
        SalesChannel, on_delete=models.CASCADE, related_name="menu_maps"
    )
    external_name = models.CharField(max_length=255, db_index=True)
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="menu_maps")
    quantity_multiplier = models.PositiveIntegerField(
        default=1,
        help_text="Multiply the order qty by this to get internal product pieces.",
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        unique_together = ("channel", "external_name")
        ordering = ["external_name"]

    def __str__(self):
        return f"{self.channel}: '{self.external_name}' → {self.quantity_multiplier}× {self.product}"
