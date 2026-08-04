from django.contrib import admin

from .models import OtherIncomeCategory, OtherIncome


@admin.register(OtherIncomeCategory)
class OtherIncomeCategoryAdmin(admin.ModelAdmin):
    list_display = ["name"]


@admin.register(OtherIncome)
class OtherIncomeAdmin(admin.ModelAdmin):
    list_display = ["date", "category", "amount", "outlet", "entered_by"]
    list_filter = ["category", "outlet", "date"]
