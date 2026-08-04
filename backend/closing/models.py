from decimal import Decimal

from django.db import models

from catalog.models import Outlet, Product
from sales.models import SalesChannel, SettlementType


class ClosingStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    SUBMITTED = "SUBMITTED", "Submitted"
    LOCKED = "LOCKED", "Locked"


class DailyClosing(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="closings")
    closing_date = models.DateField()
    staff = models.ForeignKey("accounts.User", on_delete=models.PROTECT, related_name="closings")
    status = models.CharField(
        max_length=10, choices=ClosingStatus.choices, default=ClosingStatus.DRAFT
    )
    submitted_at = models.DateTimeField(null=True, blank=True)
    # Cached on submit; the live truth is the has_flag property below.
    has_variance_flag = models.BooleanField(default=False)

    class Meta:
        unique_together = ("outlet", "closing_date")
        ordering = ["-closing_date"]

    def __str__(self):
        return f"Closing {self.closing_date} @ {self.outlet} ({self.status})"

    @property
    def has_flag(self):
        return self.stock_counts.filter(flag=True).exists()

    # ---- financial rollups (per CLAUDE.md PaymentEntry formulas) ----
    @property
    def total_sale(self):
        return sum((l.net_amount for l in self.sales_lines.all()), Decimal("0"))

    @property
    def channel_day_net_revenue(self):
        """Σ net_amount − DailyChannelDiscount, across channels."""
        discounts = sum((d.discount_amount for d in self.channel_discounts.all()), Decimal("0"))
        return self.total_sale - discounts

    @property
    def online_payments(self):
        """Σ net_amount for DIRECT_TO_ACCOUNT channels."""
        return sum(
            (
                l.net_amount
                for l in self.sales_lines.select_related("channel")
                if l.channel.settlement_type == SettlementType.DIRECT_TO_ACCOUNT
            ),
            Decimal("0"),
        )

    @property
    def total_offline_sales(self):
        return self.total_sale - self.online_payments

    @property
    def computed_cash(self):
        """Offline sales minus all non-primary-cash payment entries."""
        typed = sum(
            (p.amount for p in self.payments.filter(account__is_primary_cash=False)),
            Decimal("0"),
        )
        return self.total_offline_sales - typed


class DailyClosingStockCount(models.Model):
    daily_closing = models.ForeignKey(
        DailyClosing, on_delete=models.CASCADE, related_name="stock_counts"
    )
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    available_pieces = models.IntegerField(default=0)  # system: today's prep or current balance
    wastage_pieces = models.IntegerField(default=0)  # staff-entered, explicit
    remains_pieces = models.IntegerField(default=0)  # staff physical count ("Remains")
    app_channel_sold = models.IntegerField(default=0)  # system, filled after online-sell step
    flag = models.BooleanField(default=False)  # true if derived_walkin_sold < 0

    class Meta:
        unique_together = ("daily_closing", "product")

    @property
    def derived_walkin_sold(self):
        return (
            self.available_pieces
            - self.wastage_pieces
            - self.remains_pieces
            - self.app_channel_sold
        )

    def recompute_flag(self):
        self.flag = self.derived_walkin_sold < 0
        return self.flag

    def __str__(self):
        return f"{self.product}: remains {self.remains_pieces}"


class LineSource(models.TextChoices):
    STAFF_ENTRY = "STAFF_ENTRY", "Staff entry"
    SYSTEM_DERIVED = "SYSTEM_DERIVED", "System derived"


class DailyClosingSalesLine(models.Model):
    daily_closing = models.ForeignKey(
        DailyClosing, on_delete=models.CASCADE, related_name="sales_lines"
    )
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    channel = models.ForeignKey(SalesChannel, on_delete=models.PROTECT)
    quantity_sold = models.IntegerField(default=0)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2, default=0)  # resolved snapshot
    gross_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    commission_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    net_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    source = models.CharField(
        max_length=15, choices=LineSource.choices, default=LineSource.STAFF_ENTRY
    )

    class Meta:
        unique_together = ("daily_closing", "product", "channel")

    def recompute(self):
        self.gross_amount = Decimal(self.quantity_sold) * self.unit_price
        self.commission_amount = (
            self.gross_amount * self.channel.commission_rate
        ).quantize(Decimal("0.01"))
        self.net_amount = self.gross_amount - self.commission_amount

    def __str__(self):
        return f"{self.product} × {self.quantity_sold} @ {self.channel}"


class DailyChannelDiscount(models.Model):
    """Applied once at channel-day level, read off the channel app's summary."""

    daily_closing = models.ForeignKey(
        DailyClosing, on_delete=models.CASCADE, related_name="channel_discounts"
    )
    channel = models.ForeignKey(SalesChannel, on_delete=models.PROTECT)
    discount_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    note = models.CharField(max_length=255, blank=True)

    class Meta:
        unique_together = ("daily_closing", "channel")


class PaymentEntry(models.Model):
    """Staff-entered amounts received into each financial account at day-end.
    The primary-cash account amount is auto-computed as the remainder."""

    daily_closing = models.ForeignKey(
        DailyClosing, on_delete=models.CASCADE, related_name="payments"
    )
    account = models.ForeignKey(
        "finance.FinancialAccount", on_delete=models.PROTECT, related_name="daily_payments"
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    class Meta:
        unique_together = ("daily_closing", "account")


class SettlementStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    RECEIVED = "RECEIVED", "Received"
    PARTIAL = "PARTIAL", "Partial"
    DISPUTED = "DISPUTED", "Disputed"


class ChannelSettlement(models.Model):
    """Only relevant for DIRECT_TO_ACCOUNT channels."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="settlements")
    channel = models.ForeignKey(SalesChannel, on_delete=models.PROTECT)
    period_start = models.DateField()
    period_end = models.DateField()
    expected_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    received_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    received_date = models.DateField(null=True, blank=True)
    status = models.CharField(
        max_length=10, choices=SettlementStatus.choices, default=SettlementStatus.PENDING
    )
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-period_end"]

    def __str__(self):
        return f"{self.channel} {self.period_start}–{self.period_end} ({self.status})"
