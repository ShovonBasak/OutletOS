"""Add FinancialAccount.accepts_customer_payments.

Backfills True for every existing active Bank/Mobile Wallet account — the
Payments screen previously decided what to show by excluding is_primary_cash
+ Supplier Credit + Sales Channel (a CASH account that's merely NOT primary,
e.g. "Owner Cash", slipped through that exclusion list and showed up as a
payable option, which it never should have been). This backfill preserves
the screen's current correct behavior for the accounts that were already
right, while the new explicit flag — rather than type-based exclusion —
fixes the Owner Cash leak going forward.
"""
from django.db import migrations, models


def backfill_existing_payment_accounts(apps, schema_editor):
    FinancialAccount = apps.get_model("finance", "FinancialAccount")
    FinancialAccount.objects.filter(
        account_type__in=["BANK", "MOBILE_WALLET"], is_active=True,
    ).update(accepts_customer_payments=True)


class Migration(migrations.Migration):

    dependencies = [
        ('finance', '0014_alter_roledefaultaccount_options'),
    ]

    operations = [
        migrations.AddField(
            model_name='financialaccount',
            name='accepts_customer_payments',
            field=models.BooleanField(default=False, help_text="Offered on the day-closing Payments screen as something a customer could have paid into. Only meaningful for Bank/Mobile Wallet accounts — cash is computed, not typed in, and Supplier Credit/Sales Channel holding accounts aren't something a customer pays."),
        ),
        migrations.RunPython(backfill_existing_payment_accounts, migrations.RunPython.noop),
    ]
