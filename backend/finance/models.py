from django.db import models
from django.db.models import Sum

from catalog.models import Outlet


class AccountType(models.TextChoices):
    BANK = "BANK", "Bank"
    MOBILE_WALLET = "MOBILE_WALLET", "Mobile Wallet"
    CASH = "CASH", "Cash"
    SUPPLIER_CREDIT = "SUPPLIER_CREDIT", "Supplier Credit"


class FinancialAccount(models.Model):
    outlet = models.ForeignKey(
        Outlet, on_delete=models.CASCADE, null=True, blank=True,
        related_name="financial_accounts"
    )
    account_type = models.CharField(max_length=20, choices=AccountType.choices)
    name = models.CharField(max_length=120)
    provider = models.CharField(max_length=80, blank=True)
    opening_balance = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    opening_balance_date = models.DateField()
    is_active = models.BooleanField(default=True)
    is_primary_cash = models.BooleanField(
        default=False,
        help_text="Marks this as the shop's main cash account. Day-closing cash is "
                  "computed as total offline sales minus all other payment entries.",
    )

    class Meta:
        ordering = ["account_type", "name"]

    def __str__(self):
        return f"{self.name} ({self.get_account_type_display()})"

    @property
    def current_balance(self):
        txn_sum = self.transactions.aggregate(total=Sum("amount"))["total"] or 0
        return self.opening_balance + txn_sum


class AccountRoleAccess(models.Model):
    """Controls which accounts are available per user role.

    If any rows exist for a role, only those accounts are offered to that role.
    If no rows exist for a role, all active accounts are available (default-open).
    """
    ROLE_CHOICES = [("STAFF", "Staff"), ("OWNER", "Owner"), ("ADMIN", "Admin")]

    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="role_access"
    )

    class Meta:
        unique_together = [("role", "account")]
        ordering = ["role", "account__name"]

    def __str__(self):
        return f"{self.role} → {self.account.name}"


class TransactionType(models.TextChoices):
    SALES_COLLECTION = "SALES_COLLECTION", "Sales Collection"
    EXPENSE_PAYMENT = "EXPENSE_PAYMENT", "Expense Payment"
    TRANSFER_IN = "TRANSFER_IN", "Transfer In"
    TRANSFER_OUT = "TRANSFER_OUT", "Transfer Out"
    CAPITAL_INJECTION = "CAPITAL_INJECTION", "Capital Injection"
    OWNER_WITHDRAWAL = "OWNER_WITHDRAWAL", "Owner Withdrawal"
    ADJUSTMENT = "ADJUSTMENT", "Adjustment"
    SUPPLIER_ORDER_DEDUCTION = "SUPPLIER_ORDER_DEDUCTION", "Supplier Order Deduction"
    OTHER_INCOME = "OTHER_INCOME", "Other Income"


class SourceType(models.TextChoices):
    DAILY_CLOSING = "DAILY_CLOSING", "Daily Closing"
    EXPENSE = "EXPENSE", "Expense"
    ACCOUNT_TRANSFER = "ACCOUNT_TRANSFER", "Account Transfer"
    CAPITAL_TRANSACTION = "CAPITAL_TRANSACTION", "Capital Transaction"
    ACCOUNT_BALANCE_CHECK = "ACCOUNT_BALANCE_CHECK", "Account Balance Check"
    STOCK_IN_RECORD = "STOCK_IN_RECORD", "Stock In Record"
    OTHER_INCOME = "OTHER_INCOME", "Other Income"
    MANUAL = "MANUAL", "Manual Entry"


class AccountTransaction(models.Model):
    account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="transactions"
    )
    transaction_type = models.CharField(max_length=30, choices=TransactionType.choices)
    # Signed: positive = increases balance, negative = decreases balance
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    date = models.DateField()
    source_type = models.CharField(max_length=30, choices=SourceType.choices, blank=True)
    source_id = models.IntegerField(null=True, blank=True)
    entered_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="account_transactions"
    )
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["-date", "-id"]

    def __str__(self):
        sign = "+" if self.amount >= 0 else ""
        return f"{self.get_transaction_type_display()} {sign}{self.amount} on {self.date}"


class AccountTransfer(models.Model):
    from_account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="transfers_out"
    )
    to_account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="transfers_in"
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    date = models.DateField()
    note = models.TextField(blank=True)
    entered_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="account_transfers"
    )

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"Transfer ৳{self.amount}: {self.from_account.name} → {self.to_account.name} ({self.date})"


class CapitalDirection(models.TextChoices):
    INJECTION = "INJECTION", "Capital Injection"
    WITHDRAWAL = "WITHDRAWAL", "Owner Withdrawal"


class CapitalTransaction(models.Model):
    account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="capital_transactions"
    )
    direction = models.CharField(max_length=10, choices=CapitalDirection.choices)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    date = models.DateField()
    note = models.TextField(blank=True)
    entered_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="capital_transactions"
    )

    class Meta:
        ordering = ["-date"]

    def __str__(self):
        return f"{self.get_direction_display()} ৳{self.amount} ({self.date})"


class BalanceCheckReason(models.TextChoices):
    BANK_FEE = "BANK_FEE", "Bank Fee"
    INTEREST = "INTEREST", "Interest"
    MISSED_TRANSACTION = "MISSED_TRANSACTION", "Missed Transaction"
    OTHER = "OTHER", "Other"


class AccountBalanceCheck(models.Model):
    account = models.ForeignKey(
        FinancialAccount, on_delete=models.CASCADE, related_name="balance_checks"
    )
    checked_at = models.DateTimeField()
    checked_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="balance_checks"
    )
    system_balance = models.DecimalField(max_digits=14, decimal_places=2)
    actual_balance = models.DecimalField(max_digits=14, decimal_places=2)
    discrepancy = models.DecimalField(max_digits=14, decimal_places=2)
    reason = models.CharField(max_length=30, choices=BalanceCheckReason.choices, blank=True)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["-checked_at"]

    def __str__(self):
        return f"Balance check: {self.account.name} at {self.checked_at:%Y-%m-%d}"
