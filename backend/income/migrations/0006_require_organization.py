import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("income", "0005_backfill_otherincomecategory_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="otherincomecategory",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="other_income_categories", to="catalog.organization"),
        ),
    ]
