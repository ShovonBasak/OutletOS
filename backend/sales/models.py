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
    organization = models.ForeignKey(
        "catalog.Organization", on_delete=models.PROTECT, related_name="sales_channels",
    )
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
    # For DIRECT_TO_ACCOUNT channels: the FinancialAccount (AccountType.SALES_CHANNEL)
    # that HOLDS this channel's revenue until the platform actually pays out —
    # each day's net sales for this channel post here on close (see
    # closing.services.record_account_transactions), so its balance always
    # reads as "what this channel currently owes the outlet." Settling later
    # transfers out of it into wherever the payout landed (mark_channel_settlement_received).
    # Optional — COLLECTED_AT_OUTLET channels don't need one since that cash is
    # already part of the day's normal cash/payments math.
    holding_account = models.ForeignKey(
        "finance.FinancialAccount", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="sales_channels",
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

    organization = models.ForeignKey(
        "catalog.Organization", on_delete=models.CASCADE, related_name="channel_promotions",
    )
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

    organization = models.ForeignKey(
        "catalog.Organization", on_delete=models.CASCADE, related_name="order_level_offers",
    )
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
    """Maps an online platform's item name to one or more internal products, each
    with its own quantity. A plain 1-product mapping is just one item underneath —
    a package/combo listed as a single platform line (e.g. "Burger & 2 Chicken Ball")
    is the same mapping with more than one item.

    e.g. "3X Hot & Crispy Chicken" → 1 item: 3× Hot & Crispy Chicken
         "Burger & 2 Chicken Ball" → 2 items: 1× Five Star Burger, 2× Chicken Ball
    """

    channel = models.ForeignKey(
        SalesChannel, on_delete=models.CASCADE, related_name="menu_maps"
    )
    external_name = models.CharField(max_length=255, db_index=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        unique_together = ("channel", "external_name")
        ordering = ["external_name"]

    def __str__(self):
        parts = " + ".join(f"{i.quantity}× {i.product}" for i in self.items.all())
        return f"{self.channel}: '{self.external_name}' → {parts}"


class ChannelMenuMapItem(models.Model):
    """One (product, quantity) component of a ChannelMenuMap."""

    menu_map = models.ForeignKey(ChannelMenuMap, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="channel_menu_map_items"
    )
    quantity = models.PositiveIntegerField(
        default=1,
        help_text="Multiply the order qty by this to get internal product pieces.",
    )

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.quantity}× {self.product}"
