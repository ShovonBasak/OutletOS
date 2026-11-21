"""Backfill Ingredient.bundle_size from PackDefinition.pieces_per_pack.

(The field itself is added earlier, in 0008_ingredient_bundle_size_early —
before this table's two organization-related rebuilds — so it survives
them intact on every database, including ones descended from `prod`.)

Backfills bundle_size from each PERIODIC_COUNT ingredient's current active
PackDefinition.pieces_per_pack as a starting point — for most such ingredients
(e.g. bamboo skewers, delivered and physically bundled in the same quantity)
the two numbers already coincide. Ingredients where they genuinely differ
(e.g. sauce/ketchup sachets, whose slips report piece counts directly) need
bundle_size corrected afterward via the staff Packaging screen — this
migration only seeds a reasonable default, it doesn't get every ingredient
right. Only fills ingredients still at null, so it can't clobber a value
prod's own history (or a later staff edit) already set.
"""
from django.db import migrations


def backfill_bundle_size(apps, schema_editor):
    Ingredient = apps.get_model("catalog", "Ingredient")
    PackDefinition = apps.get_model("catalog", "PackDefinition")

    for ingredient in Ingredient.objects.filter(
        tracking_mode="PERIODIC_COUNT", bundle_size__isnull=True
    ):
        active = PackDefinition.objects.filter(
            ingredient=ingredient, effective_to__isnull=True
        ).first()
        if active:
            ingredient.bundle_size = active.pieces_per_pack
            ingredient.save(update_fields=["bundle_size"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0010_require_organization"),
    ]

    operations = [
        migrations.RunPython(backfill_bundle_size, migrations.RunPython.noop),
    ]
