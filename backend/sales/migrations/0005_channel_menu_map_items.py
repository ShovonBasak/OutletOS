"""Support mapping one platform menu item to multiple internal products.

Previously ChannelMenuMap held exactly one `product` + `quantity_multiplier`.
A platform package/combo listed as a single line (e.g. "Burger & 2 Chicken
Ball") couldn't be expressed. This replaces the single product/multiplier
pair with a `ChannelMenuMapItem` child table (one row per component),
migrating any existing mapping into a single item before dropping the old
fields.
"""
from django.db import migrations, models
import django.db.models.deletion


def migrate_existing_mappings(apps, schema_editor):
    ChannelMenuMap = apps.get_model("sales", "ChannelMenuMap")
    ChannelMenuMapItem = apps.get_model("sales", "ChannelMenuMapItem")

    for m in ChannelMenuMap.objects.all():
        ChannelMenuMapItem.objects.create(
            menu_map_id=m.id, product_id=m.product_id, quantity=m.quantity_multiplier,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0009_alter_ingredient_bundle_size"),
        ("sales", "0004_remove_channel_price"),
    ]

    operations = [
        migrations.CreateModel(
            name="ChannelMenuMapItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("quantity", models.PositiveIntegerField(default=1, help_text="Multiply the order qty by this to get internal product pieces.")),
                (
                    "menu_map",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="items",
                        to="sales.channelmenumap",
                    ),
                ),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="channel_menu_map_items",
                        to="catalog.product",
                    ),
                ),
            ],
            options={"ordering": ["id"]},
        ),
        migrations.RunPython(migrate_existing_mappings, migrations.RunPython.noop),
        migrations.RemoveField(model_name="channelmenumap", name="product"),
        migrations.RemoveField(model_name="channelmenumap", name="quantity_multiplier"),
    ]
