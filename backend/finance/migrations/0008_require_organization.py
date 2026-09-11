import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0007_backfill_financialaccount_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="financialaccount",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="financial_accounts", to="catalog.organization"),
        ),
    ]
