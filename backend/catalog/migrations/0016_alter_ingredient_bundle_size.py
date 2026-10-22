"""Tighten Ingredient.bundle_size to a whole-number field.

'Bundle finished' and the owner's bundle-size editor both only make sense in
whole pieces (you can't finish half a bundle) — the model should enforce
that a staff/owner-entered decimal can't ever corrupt. Rounds any existing
fractional value (from the DecimalField backfill in 0011) before narrowing
the column type, so no data is lost or silently truncated.
"""
from django.db import migrations, models


def round_bundle_size(apps, schema_editor):
    Ingredient = apps.get_model("catalog", "Ingredient")
    for ingredient in Ingredient.objects.exclude(bundle_size__isnull=True):
        rounded = round(ingredient.bundle_size)
        if rounded != ingredient.bundle_size:
            ingredient.bundle_size = rounded
            ingredient.save(update_fields=["bundle_size"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0015_add_is_channel_template"),
    ]

    operations = [
        migrations.RunPython(round_bundle_size, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="ingredient",
            name="bundle_size",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
