from django.contrib import admin
from .models import FinancialAccount, AccountTransaction, AccountTransfer, CapitalTransaction, AccountBalanceCheck

admin.site.register(FinancialAccount)
admin.site.register(AccountTransaction)
admin.site.register(AccountTransfer)
admin.site.register(CapitalTransaction)
admin.site.register(AccountBalanceCheck)
