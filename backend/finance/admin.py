from django.contrib import admin
from .models import FinancialAccount, AccountRoleAccess, AccountTransaction, AccountTransfer, CapitalTransaction, AccountBalanceCheck


@admin.register(AccountRoleAccess)
class AccountRoleAccessAdmin(admin.ModelAdmin):
    list_display = ["role", "account"]
    list_filter = ["role"]
    ordering = ["role", "account__name"]


admin.site.register(FinancialAccount)
admin.site.register(AccountTransaction)
admin.site.register(AccountTransfer)
admin.site.register(CapitalTransaction)
admin.site.register(AccountBalanceCheck)
