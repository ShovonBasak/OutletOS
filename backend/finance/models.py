from django.db import models
from django.utils import timezone

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
        """The ledger's last posted balance — not a live re-sum. Every posting
        path (finance.services) maintains balance_before/after on each
        AccountTransaction, so the latest row's balance_after IS the current
        balance. If this ever looks wrong, rebuild_account_balances() is the
        self-healing repair (also exposed as the owner's "Recalculate" action)."""
        latest = self.transactions.order_by("-date", "-id").first()
        return latest.balance_after if latest else self.opening_balance


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
    # Running-balance snapshot, maintained exclusively by finance.services
    # (post_transaction / void_transaction / rebuild_account_balances) — never
    # set directly. Computed in LEDGER ORDER (date, id) ascending, which is
    # distinct from Meta.ordering below (display order, newest first): date is
    # freely backdatable, so `id` — assigned once at insertion, never changes —
    # is what disambiguates same-day rows for balance math.
    balance_before = models.DecimalField(max_digits=14, decimal_places=2)
    balance_after = models.DecimalField(max_digits=14, decimal_places=2)
    # Real insertion timestamp (audit/display only — plays no role in balance
    # math, which uses `date` + `id`). For rows backfilled by the 0006 data
    # migration this is only a best-effort approximation (date at midnight).
    created_at = models.DateTimeField(default=timezone.now, editable=False)

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
