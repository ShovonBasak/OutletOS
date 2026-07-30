from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0002_productprice"),
    ]

    operations = [
        migrations.CreateModel(
            name="RecipeProductComponent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("quantity_per_unit", models.DecimalField(decimal_places=3, default=1, max_digits=10)),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="product_recipe_components",
                        to="catalog.product",
                    ),
                ),
                (
                    "component_product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="used_as_prep_component",
                        to="catalog.product",
                    ),
                ),
            ],
            options={
                "ordering": ["id"],
                "unique_together": {("product", "component_product")},
            },
        ),
    ]
