import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0006_backfill_saleschannel_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="saleschannel",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="sales_channels", to="catalog.organization"),
        ),
    ]
