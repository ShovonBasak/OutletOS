"""Support mapping one platform menu item to multiple internal products.

Previously ChannelMenuMap held exactly one `product` + `quantity_multiplier`.
A platform package/combo listed as a single line (e.g. "Burger & 2 Chicken
Ball") couldn't be expressed. This replaces the single product/multiplier
pair with a `ChannelMenuMapItem` child table (one row per component),
migrating any existing mapping into a single item before dropping the old
fields.

Defensive against databases descended from `prod`, which added this exact
table and dropped these exact columns under a different migration (it
predates the org-scoping work this branch forked for). CreateModelIfMissing
/ RemoveFieldIfPresent check the real schema via introspection before
acting, falling back to Django's normal behavior only when there's actually
something to do — so this migration is a no-op on such a database, while
Django's migration state (and therefore every later migration and the app
code) still ends up on the correct model shape either way.
"""
from django.db import migrations, models
import django.db.models.deletion


def _table_exists(schema_editor, table_name):
    return table_name in schema_editor.connection.introspection.table_names()


def _column_exists(schema_editor, table_name, column_name):
    if not _table_exists(schema_editor, table_name):
        return False
    with schema_editor.connection.cursor() as cursor:
        columns = schema_editor.connection.introspection.get_table_description(cursor, table_name)
    return any(c.name == column_name for c in columns)


class CreateModelIfMissing(migrations.CreateModel):
    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        to_model = to_state.apps.get_model(app_label, self.name)
        if _table_exists(schema_editor, to_model._meta.db_table):
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass  # one-off reconciliation migration — reverse not supported


class RemoveFieldIfPresent(migrations.RemoveField):
    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        from_model = from_state.apps.get_model(app_label, self.model_name)
        # A ForeignKey's real column is "<name>_id", not the field's logical
        # name — check the field's actual .column, not self.name directly.
        column = from_model._meta.get_field(self.name).column
        if not _column_exists(schema_editor, from_model._meta.db_table, column):
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass  # one-off reconciliation migration — reverse not supported


def migrate_existing_mappings(apps, schema_editor):
    if not _column_exists(schema_editor, "sales_channelmenumap", "product_id"):
        return  # already migrated via a parallel history (e.g. prod)
    ChannelMenuMap = apps.get_model("sales", "ChannelMenuMap")
    ChannelMenuMapItem = apps.get_model("sales", "ChannelMenuMapItem")

    for m in ChannelMenuMap.objects.all():
        ChannelMenuMapItem.objects.get_or_create(
            menu_map_id=m.id, product_id=m.product_id,
            defaults={"quantity": m.quantity_multiplier},
        )


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0001_initial"),
        ("sales", "0011_saleschannel_holding_account"),
    ]

    operations = [
        CreateModelIfMissing(
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
        RemoveFieldIfPresent(model_name="channelmenumap", name="product"),
        RemoveFieldIfPresent(model_name="channelmenumap", name="quantity_multiplier"),
    ]
