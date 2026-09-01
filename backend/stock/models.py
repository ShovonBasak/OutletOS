from decimal import Decimal

from django.conf import settings
from django.db import models

from catalog.models import Ingredient, Outlet, PackDefinition, Product


# ---------------------------------------------------------------------------
# Operating day — gates the whole staff daily flow (start → stock → prep → close)
# ---------------------------------------------------------------------------
class OperatingDayStatus(models.TextChoices):
    NOT_STARTED = "NOT_STARTED", "Not started"
    STOCK_CONFIRMED = "STOCK_CONFIRMED", "Day-start stock confirmed"
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    CLOSED = "CLOSED", "Closed"


class OperatingDay(models.Model):
    """One row per outlet per date. Gates Stock In / Preparation / Closing:
    NOT_STARTED → STOCK_CONFIRMED (day-start stock done, Stock In unlocks) →
    IN_PROGRESS (carry-forward done, full app unlocked) → CLOSED."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="operating_days")
    date = models.DateField()
    status = models.CharField(
        max_length=16, choices=OperatingDayStatus.choices,
        default=OperatingDayStatus.NOT_STARTED,
    )
    started_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="started_days",
    )
    started_at = models.DateTimeField(null=True, blank=True)
    stock_confirmed_at = models.DateTimeField(null=True, blank=True)
    carry_forward_confirmed_at = models.DateTimeField(null=True, blank=True)
    daily_closing = models.ForeignKey(
        "closing.DailyClosing", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="operating_day",
    )

    class Meta:
        unique_together = ("outlet", "date")
        ordering = ["-date"]

    def __str__(self):
        return f"OperatingDay {self.date} @ {self.outlet} ({self.status})"

    @property
    def stock_in_unlocked(self):
        return self.status in (
            OperatingDayStatus.STOCK_CONFIRMED,
            OperatingDayStatus.IN_PROGRESS,
        )

    @property
    def full_unlocked(self):
        return self.status == OperatingDayStatus.IN_PROGRESS


class DiscrepancyReason(models.TextChoices):
    SPOILED = "SPOILED", "Spoiled"
    MISCOUNTED_YESTERDAY = "MISCOUNTED_YESTERDAY", "Miscounted yesterday"
    SURPLUS_FOUND = "SURPLUS_FOUND", "Surplus found"
    OTHER = "OTHER", "Other"


class DayStartStockCheck(models.Model):
    """Morning reconciliation: staff confirms each ingredient's carried RawStock,
    any discrepancy needs a reason. Feeds the Shrinkage P&L line."""

    operating_day = models.ForeignKey(
        OperatingDay, on_delete=models.CASCADE, related_name="stock_checks"
    )
    ingredient = models.ForeignKey(Ingredient, on_delete=models.PROTECT)
    system_carried_qty = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    confirmed_qty = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    discrepancy_reason = models.CharField(
        max_length=24, choices=DiscrepancyReason.choices, blank=True
    )
    note = models.TextField(blank=True)

    class Meta:
        unique_together = ("operating_day", "ingredient")

    @property
    def discrepancy_qty(self):
        """Positive = shortfall (missing), negative = surplus."""
        return self.system_carried_qty - self.confirmed_qty

    @property
    def needs_reason(self):
        return self.discrepancy_qty != 0

    def __str__(self):
        return f"{self.ingredient}: {self.confirmed_qty} (Δ {self.discrepancy_qty})"


# ---------------------------------------------------------------------------
# Stock In (receiving stock, with or without a slip) — now ingredient-based
# ---------------------------------------------------------------------------
class StockInStatus(models.TextChoices):
    DRAFT = "DRAFT", "Draft"
    PENDING = "PENDING", "Pending"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"


class LineSource(models.TextChoices):
    SLIP_EXTRACTED = "SLIP_EXTRACTED", "Slip extracted"
    MANUAL = "MANUAL", "Manual"


class UnitCaptured(models.TextChoices):
    PACK = "PACK", "Pack"
    PIECE = "PIECE", "Piece"


class StockInRecord(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="stock_ins")
    stock_in_date = models.DateField()
    invoice_number = models.CharField(max_length=100, blank=True)
    submitted_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="submitted_stock_ins"
    )
    status = models.CharField(
        max_length=10, choices=StockInStatus.choices, default=StockInStatus.DRAFT
    )
    reviewed_by = models.ForeignKey(
        "accounts.User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="reviewed_stock_ins",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    slip_image = models.ImageField(upload_to="slips/", null=True, blank=True)
    notes = models.TextField(blank=True)
    # Financial summary extracted from the supplier slip (BDT)
    slip_subtotal       = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    slip_discount_total = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    slip_vat_total      = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    slip_grand_total    = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    paid_from_account = models.ForeignKey(
        "finance.FinancialAccount", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="stock_ins",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-stock_in_date", "-id"]

    def __str__(self):
        return f"StockIn #{self.pk} — {self.stock_in_date} ({self.status})"

    @property
    def unresolved_lines(self):
        """Lines that block DRAFT → PENDING: no ingredient, or a PACK line with
        no pack definition to convert with."""
        blocking = []
        for item in self.items.all():
            if item.ingredient_id is None:
                blocking.append(item)
            elif item.unit_captured == UnitCaptured.PACK and item.pack_definition_id is None:
                blocking.append(item)
        return blocking


class StockInItem(models.Model):
    stock_in_record = models.ForeignKey(
        StockInRecord, on_delete=models.CASCADE, related_name="items"
    )
    # null while "Unrecognized" — resolved by staff, which also saves an alias.
    ingredient = models.ForeignKey(
        Ingredient, null=True, blank=True, on_delete=models.PROTECT
    )
    raw_extracted_text = models.CharField(max_length=255, blank=True)
    source = models.CharField(
        max_length=15, choices=LineSource.choices, default=LineSource.MANUAL
    )
    unit_captured = models.CharField(
        max_length=5, choices=UnitCaptured.choices, default=UnitCaptured.PACK
    )
    extracted_quantity = models.DecimalField(
        max_digits=10, decimal_places=3, null=True, blank=True
    )  # raw OCR, kept for audit
    confirmed_quantity = models.DecimalField(max_digits=10, decimal_places=3, default=0)
    pack_definition = models.ForeignKey(
        PackDefinition, null=True, blank=True, on_delete=models.PROTECT
    )
    # Supplier reference fields (audit / traceability only, no business logic).
    sku_code = models.CharField(max_length=50, blank=True)
    mrp      = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)

    # Price fields captured from the supplier slip (BDT).
    # unit_price   = effective cost per unit (= line_total / quantity).
    # rate         = pre-discount, pre-tax rate per pack/unit.
    # total_amount = qty × rate (pre-discount, pre-tax subtotal).
    # discount     = per-line discount amount (beverages use this instead of SD/VAT).
    # line_total   = final net cost for this line (after discount + SD + VAT).
    unit_price   = models.DecimalField(max_digits=10, decimal_places=4, null=True, blank=True)
    rate         = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    discount     = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    sd_rate      = models.DecimalField(max_digits=6,  decimal_places=2, null=True, blank=True)
    sd_amount    = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    vat_rate     = models.DecimalField(max_digits=6,  decimal_places=2, null=True, blank=True)
    vat_amount   = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    line_total   = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)

    def base_unit_quantity(self):
        """confirmed_quantity converted to the ingredient's base unit."""
        if self.unit_captured == UnitCaptured.PACK and self.pack_definition_id:
            return self.confirmed_quantity * self.pack_definition.pieces_per_pack
        return self.confirmed_quantity

    def __str__(self):
        label = self.ingredient or self.raw_extracted_text or "?"
        return f"{label} × {self.confirmed_quantity} {self.unit_captured}"


class RawStock(models.Model):
    """Derived/cached running balance per ingredient, in the ingredient's
    base_unit. Updated by approved stock-in (+) and preparation (−, via Recipe)."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="raw_stock")
    ingredient = models.ForeignKey(Ingredient, on_delete=models.CASCADE, related_name="raw_stock")
    quantity_available = models.DecimalField(max_digits=12, decimal_places=3, default=0)

    class Meta:
        unique_together = ("outlet", "ingredient")
        ordering = ["ingredient__name"]

    def __str__(self):
        return (
            f"{self.ingredient} @ {self.outlet}: "
            f"{self.quantity_available} {self.ingredient.base_unit}"
        )

    @classmethod
    def adjust(cls, outlet, ingredient, delta):
        obj, _ = cls.objects.get_or_create(outlet=outlet, ingredient=ingredient)
        obj.quantity_available = (obj.quantity_available or Decimal("0")) + Decimal(delta)
        obj.save()
        return obj

    @classmethod
    def set_to(cls, outlet, ingredient, value):
        obj, _ = cls.objects.get_or_create(outlet=outlet, ingredient=ingredient)
        obj.quantity_available = Decimal(value)
        obj.save()
        return obj


# ---------------------------------------------------------------------------
# Preparation → Display Stock
# ---------------------------------------------------------------------------
class PrepSource(models.TextChoices):
    FRESH = "FRESH", "Fresh"
    CARRIED_FORWARD = "CARRIED_FORWARD", "Carried forward"


class PrepUnit(models.TextChoices):
    PACK = "PACK", "Pack"
    PIECE = "PIECE", "Piece"


class PreparationLog(models.Model):
    """Real-time staff action; no approval. FRESH entries decrement RawStock per
    Recipe; CARRIED_FORWARD entries move yesterday's leftovers with no deduction."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="prep_logs")
    logged_by = models.ForeignKey("accounts.User", on_delete=models.PROTECT)
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    timestamp = models.DateTimeField(auto_now_add=True)
    op_date = models.DateField(
        null=True, blank=True,
        help_text="Operational date this log belongs to (may differ from timestamp when back-entering data).",
    )
    source = models.CharField(
        max_length=16, choices=PrepSource.choices, default=PrepSource.FRESH
    )
    carried_forward_from = models.ForeignKey(
        "closing.DailyClosingStockCount", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="carry_forwards",
    )
    leftover_available_pieces = models.IntegerField(null=True, blank=True)
    # FRESH only: PACK is shorthand for "N packs of the single recipe ingredient".
    prep_unit = models.CharField(max_length=5, choices=PrepUnit.choices, default=PrepUnit.PIECE)
    packs_used = models.DecimalField(max_digits=10, decimal_places=3, null=True, blank=True)
    pieces_prepared = models.PositiveIntegerField(default=0)
    # CARRIED_FORWARD only: leftover_available_pieces − pieces_prepared.
    wastage_pieces = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-timestamp"]

    def __str__(self):
        return f"{self.product} → {self.pieces_prepared} pcs ({self.source})"


class DisplayStock(models.Model):
    """Derived/cached ready-to-sell pieces per outlet/product for the day."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="display_stock")
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="display_stock")
    pieces_available = models.IntegerField(default=0)

    class Meta:
        unique_together = ("outlet", "product")
        ordering = ["product__name"]

    def __str__(self):
        return f"{self.product} @ {self.outlet}: {self.pieces_available} pcs"

    @classmethod
    def adjust(cls, outlet, product, delta):
        obj, _ = cls.objects.get_or_create(outlet=outlet, product=product)
        # Clamp to 0 — DS can't go negative. Without this, deleting a prep log
        # that was already "erased" by a CF reset would push DS below zero and
        # future preps wouldn't fully compensate.
        obj.pieces_available = max(0, (obj.pieces_available or 0) + int(delta))
        obj.save()
        return obj


# ---------------------------------------------------------------------------
# Packaging & supplies — periodic-count tracking (no fixed per-product ratio)
# ---------------------------------------------------------------------------
class PeriodicStockCheck(models.Model):
    """Running ledger of 'how much is left' snapshots for PERIODIC_COUNT
    ingredients. Consumption is inferred between checks, not per-transaction."""

    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="periodic_checks")
    ingredient = models.ForeignKey(
        Ingredient, on_delete=models.PROTECT, related_name="periodic_checks"
    )
    checked_at = models.DateTimeField(auto_now_add=True)
    checked_by = models.ForeignKey("accounts.User", on_delete=models.PROTECT)
    counted_qty = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    stock_in_since_last_check = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    consumed_since_last_check = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["-checked_at"]

    def __str__(self):
        return f"{self.ingredient}: {self.counted_qty} left"


# ---------------------------------------------------------------------------
# Fryer oil change log
# ---------------------------------------------------------------------------
class FryerOilChange(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="fryer_oil_changes")
    pan_number = models.PositiveSmallIntegerField(choices=[(1, "Pan 1"), (2, "Pan 2")])
    changed_at = models.DateField()
    logged_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="fryer_oil_changes")
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-changed_at", "-created_at"]

    def __str__(self):
        return f"Pan {self.pan_number} oil change — {self.changed_at}"
