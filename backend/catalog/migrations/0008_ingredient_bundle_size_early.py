"""Introduce Ingredient.bundle_size into Django's migration STATE early —
before 0008_organization_ingredient_organization_and_more and
0010_require_organization touch the Ingredient model.

On SQLite, Django implements an AddField/AlterField/RemoveField as a full
table rebuild: a new table is created from the CURRENT MIGRATION STATE's
field list, data is copied from the old table, the old table is dropped,
and the new one renamed in. Any physical column the old table has that
migration state doesn't know about yet gets silently left out of that
rebuild — which is exactly bundle_size's situation on a database descended
from `prod` (which added this column, under a different migration, before
these two branches forked). Declaring it in state here — before either of
those two Ingredient-rebuilding migrations run — means every later rebuild
in this app's history carries it through intact, whether or not it
physically exists yet: AddFieldIfMissing only touches the real schema if
the column is actually missing (the ordinary, non-`prod`-descended case).
"""
from django.db import migrations, models


def _column_exists(schema_editor, table_name, column_name):
    with schema_editor.connection.cursor() as cursor:
        columns = schema_editor.connection.introspection.get_table_description(cursor, table_name)
    return any(c.name == column_name for c in columns)


class AddFieldIfMissing(migrations.AddField):
    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        to_model = to_state.apps.get_model(app_label, self.model_name)
        if _column_exists(schema_editor, to_model._meta.db_table, self.name):
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass  # one-off reconciliation migration — reverse not supported


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0007_ingredient_group"),
    ]

    operations = [
        AddFieldIfMissing(
            model_name="ingredient",
            name="bundle_size",
            field=models.DecimalField(max_digits=10, decimal_places=3, null=True, blank=True),
        ),
    ]
