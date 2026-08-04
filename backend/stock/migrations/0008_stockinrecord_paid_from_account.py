from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0002_seed_default_accounts"),
        ("stock", "0007_beverage_slip_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="stockinrecord",
            name="paid_from_account",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="stock_ins",
                to="finance.financialaccount",
            ),
        ),
    ]
