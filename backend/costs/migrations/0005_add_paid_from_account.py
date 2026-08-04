import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("costs", "0004_add_expense_source"),
        ("finance", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="expense",
            name="paid_from_account",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="expenses",
                to="finance.financialaccount",
            ),
        ),
    ]
