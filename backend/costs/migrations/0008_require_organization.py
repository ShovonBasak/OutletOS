import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("costs", "0007_backfill_costcategory_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="costcategory",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="cost_categories", to="catalog.organization"),
        ),
    ]
