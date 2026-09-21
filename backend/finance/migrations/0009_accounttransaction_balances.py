"""Add running-balance tracking to AccountTransaction.

balance_before / balance_after are added with a one-off default of 0 (required
for the AddField on a non-nullable column with existing rows), then
immediately backfilled by replaying each account's transaction history in
LEDGER ORDER — (date, id) ascending — from opening_balance forward. This is
the same algorithm finance.services.rebuild_account_balances uses, but
reimplemented self-contained here (via apps.get_model) rather than imported,
since app code is free to keep evolving after this migration is frozen in
history.

created_at (real insertion timestamp, audit/display only — not used in
balance math) is backfilled for historical rows as `date` at midnight: a
best-effort approximation, since the true original entry time was never
recorded. Every row created after this migration gets a real timestamp via
the model's `default=timezone.now`.
"""
from datetime import datetime, time

from django.db import migrations, models
from django.utils import timezone


def backfill_balances(apps, schema_editor):
    FinancialAccount = apps.get_model("finance", "FinancialAccount")
    AccountTransaction = apps.get_model("finance", "AccountTransaction")

    for account in FinancialAccount.objects.all():
        running = account.opening_balance
        rows = []
        for txn in account.transactions.order_by("date", "id"):
            txn.balance_before = running
            running = running + txn.amount
            txn.balance_after = running
            txn.created_at = timezone.make_aware(datetime.combine(txn.date, time.min))
            rows.append(txn)
        if rows:
            AccountTransaction.objects.bulk_update(
                rows, ["balance_before", "balance_after", "created_at"], batch_size=500
            )


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0008_require_organization"),
    ]

    operations = [
        migrations.AddField(
            model_name="accounttransaction",
            name="balance_before",
            field=models.DecimalField(max_digits=14, decimal_places=2, default=0),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="accounttransaction",
            name="balance_after",
            field=models.DecimalField(max_digits=14, decimal_places=2, default=0),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="accounttransaction",
            name="created_at",
            field=models.DateTimeField(default=timezone.now, editable=False),
        ),
        migrations.RunPython(backfill_balances, migrations.RunPython.noop),
    ]
