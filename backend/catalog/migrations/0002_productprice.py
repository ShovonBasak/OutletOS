"""Add ProductPrice (version-tracked selling price) and migrate existing data.

Steps:
  1. Create ProductPrice table
  2. Data migration: create one ProductPrice row per existing Product,
     price = product.selling_price, effective_from = today, changed_by = null
  3. Remove Product.selling_price
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.utils import timezone


def forward_migrate_prices(apps, schema_editor):
    Product = apps.get_model("catalog", "Product")
    ProductPrice = apps.get_model("catalog", "ProductPrice")
    today = timezone.localdate()
    for product in Product.objects.all():
        price = getattr(product, "selling_price", None)
        if price is None:
            price = 0
        ProductPrice.objects.create(
            product=product,
            price=price,
            effective_from=today,
            effective_to=None,
            changed_by=None,
            note="Migrated from initial selling_price field",
        )


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # 1. Create the new table
        migrations.CreateModel(
            name="ProductPrice",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("price", models.DecimalField(decimal_places=2, max_digits=10)),
                ("effective_from", models.DateField()),
                ("effective_to", models.DateField(blank=True, null=True)),
                ("note", models.TextField(blank=True)),
                (
                    "changed_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="product_price_changes",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="prices",
                        to="catalog.product",
                    ),
                ),
            ],
            options={
                "ordering": ["-effective_from"],
            },
        ),
        # 2. Migrate existing selling_price values
        migrations.RunPython(forward_migrate_prices, migrations.RunPython.noop),
        # 3. Remove the now-redundant column
        migrations.RemoveField(
            model_name="product",
            name="selling_price",
        ),
    ]
