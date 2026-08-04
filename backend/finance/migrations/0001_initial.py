import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ("catalog", "0007_ingredient_group"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="FinancialAccount",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("account_type", models.CharField(
                    choices=[
                        ("BANK", "Bank"),
                        ("MOBILE_WALLET", "Mobile Wallet"),
                        ("CASH", "Cash"),
                        ("SUPPLIER_CREDIT", "Supplier Credit"),
                    ],
                    max_length=20,
                )),
                ("name", models.CharField(max_length=120)),
                ("provider", models.CharField(blank=True, max_length=80)),
                ("opening_balance", models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("opening_balance_date", models.DateField()),
                ("is_active", models.BooleanField(default=True)),
                ("outlet", models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="financial_accounts",
                    to="catalog.outlet",
                )),
            ],
            options={"ordering": ["account_type", "name"]},
        ),
        migrations.CreateModel(
            name="AccountTransaction",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("transaction_type", models.CharField(
                    choices=[
                        ("SALES_COLLECTION", "Sales Collection"),
                        ("EXPENSE_PAYMENT", "Expense Payment"),
                        ("TRANSFER_IN", "Transfer In"),
                        ("TRANSFER_OUT", "Transfer Out"),
                        ("CAPITAL_INJECTION", "Capital Injection"),
                        ("OWNER_WITHDRAWAL", "Owner Withdrawal"),
                        ("ADJUSTMENT", "Adjustment"),
                        ("SUPPLIER_ORDER_DEDUCTION", "Supplier Order Deduction"),
                        ("OTHER_INCOME", "Other Income"),
                    ],
                    max_length=30,
                )),
                ("amount", models.DecimalField(decimal_places=2, max_digits=14)),
                ("date", models.DateField()),
                ("source_type", models.CharField(
                    blank=True,
                    choices=[
                        ("DAILY_CLOSING", "Daily Closing"),
                        ("EXPENSE", "Expense"),
                        ("ACCOUNT_TRANSFER", "Account Transfer"),
                        ("CAPITAL_TRANSACTION", "Capital Transaction"),
                        ("ACCOUNT_BALANCE_CHECK", "Account Balance Check"),
                        ("STOCK_IN_RECORD", "Stock In Record"),
                        ("OTHER_INCOME", "Other Income"),
                        ("MANUAL", "Manual Entry"),
                    ],
                    max_length=30,
                )),
                ("source_id", models.IntegerField(blank=True, null=True)),
                ("note", models.TextField(blank=True)),
                ("account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="transactions",
                    to="finance.financialaccount",
                )),
                ("entered_by", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="account_transactions",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["-date", "-id"]},
        ),
        migrations.CreateModel(
            name="AccountTransfer",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("amount", models.DecimalField(decimal_places=2, max_digits=14)),
                ("date", models.DateField()),
                ("note", models.TextField(blank=True)),
                ("from_account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="transfers_out",
                    to="finance.financialaccount",
                )),
                ("to_account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="transfers_in",
                    to="finance.financialaccount",
                )),
                ("entered_by", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="account_transfers",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["-date"]},
        ),
        migrations.CreateModel(
            name="CapitalTransaction",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("direction", models.CharField(
                    choices=[("INJECTION", "Capital Injection"), ("WITHDRAWAL", "Owner Withdrawal")],
                    max_length=10,
                )),
                ("amount", models.DecimalField(decimal_places=2, max_digits=14)),
                ("date", models.DateField()),
                ("note", models.TextField(blank=True)),
                ("account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="capital_transactions",
                    to="finance.financialaccount",
                )),
                ("entered_by", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="capital_transactions",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["-date"]},
        ),
        migrations.CreateModel(
            name="AccountBalanceCheck",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("checked_at", models.DateTimeField()),
                ("system_balance", models.DecimalField(decimal_places=2, max_digits=14)),
                ("actual_balance", models.DecimalField(decimal_places=2, max_digits=14)),
                ("discrepancy", models.DecimalField(decimal_places=2, max_digits=14)),
                ("reason", models.CharField(
                    blank=True,
                    choices=[
                        ("BANK_FEE", "Bank Fee"),
                        ("INTEREST", "Interest"),
                        ("MISSED_TRANSACTION", "Missed Transaction"),
                        ("OTHER", "Other"),
                    ],
                    max_length=30,
                )),
                ("note", models.TextField(blank=True)),
                ("account", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="balance_checks",
                    to="finance.financialaccount",
                )),
                ("checked_by", models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name="balance_checks",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["-checked_at"]},
        ),
    ]
