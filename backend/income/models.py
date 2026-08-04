from django.db import models

from catalog.models import Outlet


class OtherIncomeCategory(models.Model):
    name = models.CharField(max_length=80)

    class Meta:
        verbose_name_plural = "other income categories"
        ordering = ["name"]

    def __str__(self):
        return self.name


class OtherIncome(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="other_incomes")
    date = models.DateField()
    category = models.ForeignKey(OtherIncomeCategory, on_delete=models.PROTECT, related_name="entries")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    received_into_account = models.ForeignKey(
        "finance.FinancialAccount",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="income_entries",
    )
    description = models.TextField(blank=True)
    entered_by = models.ForeignKey("accounts.User", on_delete=models.PROTECT)

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"{self.category} — ৳{self.amount} ({self.date})"
