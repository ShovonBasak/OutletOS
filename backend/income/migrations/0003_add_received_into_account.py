import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("income", "0002_seed_default_categories"),
        ("finance", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="otherincome",
            name="received_into_account",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="income_entries",
                to="finance.financialaccount",
            ),
        ),
    ]
