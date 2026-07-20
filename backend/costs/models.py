from django.db import models

from catalog.models import Outlet


class CostType(models.TextChoices):
    FIXED = "FIXED", "Fixed"
    VARIABLE = "VARIABLE", "Variable"
    ADHOC = "ADHOC", "Adhoc"


class CostCategory(models.Model):
    name = models.CharField(max_length=80)
    cost_type = models.CharField(max_length=10, choices=CostType.choices)

    class Meta:
        verbose_name_plural = "cost categories"
        ordering = ["cost_type", "name"]

    def __str__(self):
        return f"{self.name} ({self.cost_type})"


class Expense(models.Model):
    outlet = models.ForeignKey(Outlet, on_delete=models.CASCADE, related_name="expenses")
    date = models.DateField()
    category = models.ForeignKey(CostCategory, on_delete=models.PROTECT, related_name="expenses")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    description = models.TextField(blank=True)
    entered_by = models.ForeignKey("accounts.User", on_delete=models.PROTECT)
    recurring = models.BooleanField(default=False)

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"{self.category} — ৳{self.amount} ({self.date})"
