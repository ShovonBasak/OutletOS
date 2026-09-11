import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0009_backfill_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="outlet",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="outlets", to="catalog.organization"),
        ),
        migrations.AlterField(
            model_name="product",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="products", to="catalog.organization"),
        ),
        migrations.AlterField(
            model_name="ingredient",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="ingredients", to="catalog.organization"),
        ),
    ]
