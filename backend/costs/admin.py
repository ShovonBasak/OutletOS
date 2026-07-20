from django.contrib import admin

from .models import CostCategory, Expense


@admin.register(CostCategory)
class CostCategoryAdmin(admin.ModelAdmin):
    list_display = ["name", "cost_type"]


@admin.register(Expense)
class ExpenseAdmin(admin.ModelAdmin):
    list_display = ["date", "category", "amount", "outlet", "recurring"]
    list_filter = ["category", "outlet", "recurring"]
