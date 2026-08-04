"""
Replace PaymentEntry.method (enum) with an account FK to FinancialAccount.
All existing PaymentEntry rows are deleted first because the enum values
(CASH/BKASH/CARD) cannot be mapped to FinancialAccount PKs automatically.
"""
from django.db import migrations, models
import django.db.models.deletion


def delete_existing_payment_entries(apps, schema_editor):
    PaymentEntry = apps.get_model("closing", "PaymentEntry")
    PaymentEntry.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("closing", "0001_initial"),
        ("finance", "0003_financialaccount_is_primary_cash"),
    ]

    operations = [
        # 1. Delete all existing rows (old enum-based entries are incompatible).
        migrations.RunPython(delete_existing_payment_entries, migrations.RunPython.noop),

        # 2. Drop the old unique constraint and method field.
        migrations.AlterUniqueTogether(
            name="paymententry",
            unique_together=set(),
        ),
        migrations.RemoveField(
            model_name="paymententry",
            name="method",
        ),

        # 3. Add the new account FK (nullable initially so the column can be added).
        migrations.AddField(
            model_name="paymententry",
            name="account",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="daily_payments",
                to="finance.financialaccount",
            ),
        ),

        # 4. Make account non-null (safe because all rows were deleted above).
        migrations.AlterField(
            model_name="paymententry",
            name="account",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="daily_payments",
                to="finance.financialaccount",
            ),
        ),

        # 5. Re-add unique constraint on the new column.
        migrations.AlterUniqueTogether(
            name="paymententry",
            unique_together={("daily_closing", "account")},
        ),
    ]
