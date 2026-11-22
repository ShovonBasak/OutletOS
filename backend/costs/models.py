from django.db import models

from catalog.models import Outlet


class CostType(models.TextChoices):
    FIXED = "FIXED", "Fixed"
    VARIABLE = "VARIABLE", "Variable"
    ADHOC = "ADHOC", "Adhoc"


class CostCategory(models.Model):
    """Global, not organization-scoped — every franchise outlet uses the same
    expense categories (platform-admin managed)."""

    name = models.CharField(max_length=80)
    cost_type = models.CharField(max_length=10, choices=CostType.choices)

    class Meta:
        verbose_name_plural = "cost categories"
        ordering = ["cost_type", "name"]

    def __str__(self):
        return f"{self.name} ({self.cost_type})"


class ExpenseSource(models.TextChoices):
    CASH = "CASH", "Cash"
    BKASH = "BKASH", "bKash"


class Expense(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="expenses")
    date = models.DateField()
    category = models.ForeignKey(CostCategory, on_delete=models.PROTECT, related_name="expenses")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    # source is kept for legacy display; new entries use paid_from_account instead
    source = models.CharField(max_length=10, choices=ExpenseSource.choices, default=ExpenseSource.CASH)
    paid_from_account = models.ForeignKey(
        "finance.FinancialAccount",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="expenses",
    )
    description = models.TextField(blank=True)
    entered_by = models.ForeignKey("accounts.User", on_delete=models.PROTECT)
    recurring = models.BooleanField(default=False)

    # Set only for system-generated expenses (e.g. a Collected-at-outlet
    # channel's commission, auto-registered on closing submit/lock — see
    # closing.services.record_commission_expenses) so that flow can find and
    # void/replace what it previously created on a re-submit, the same way
    # AccountTransaction.source_type/source_id let record_account_transactions
    # do that for ledger postings. Blank for a staff/owner-entered expense.
    source_type = models.CharField(max_length=30, blank=True)
    source_id = models.PositiveIntegerField(null=True, blank=True)

    # Soft-delete — "deleting" an expense keeps the row (and its audit trail)
    # instead of erasing it; the linked AccountTransaction is still voided so
    # it stops affecting balances/P&L. See ExpenseViewSet.perform_destroy.
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        "accounts.User", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="deleted_expenses",
    )

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"{self.category} — ৳{self.amount} ({self.date})"
