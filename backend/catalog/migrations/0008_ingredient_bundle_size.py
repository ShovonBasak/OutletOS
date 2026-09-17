"""Add Ingredient.bundle_size, decoupled from PackDefinition.pieces_per_pack.

Backfills bundle_size from each PERIODIC_COUNT ingredient's current active
PackDefinition.pieces_per_pack as a starting point — for most such ingredients
(e.g. bamboo skewers, delivered and physically bundled in the same quantity)
the two numbers already coincide. Ingredients where they genuinely differ
(e.g. sauce/ketchup sachets, whose slips report piece counts directly) need
bundle_size corrected afterward via the staff Packaging screen — this
migration only seeds a reasonable default, it doesn't get every ingredient
right.
"""
from django.db import migrations, models


def backfill_bundle_size(apps, schema_editor):
    Ingredient = apps.get_model("catalog", "Ingredient")
    PackDefinition = apps.get_model("catalog", "PackDefinition")

    for ingredient in Ingredient.objects.filter(tracking_mode="PERIODIC_COUNT"):
        active = PackDefinition.objects.filter(
            ingredient=ingredient, effective_to__isnull=True
        ).first()
        if active:
            ingredient.bundle_size = active.pieces_per_pack
            ingredient.save(update_fields=["bundle_size"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0007_ingredient_group"),
    ]

    operations = [
        migrations.AddField(
            model_name="ingredient",
            name="bundle_size",
            field=models.DecimalField(max_digits=10, decimal_places=3, null=True, blank=True),
        ),
        migrations.RunPython(backfill_bundle_size, migrations.RunPython.noop),
    ]
