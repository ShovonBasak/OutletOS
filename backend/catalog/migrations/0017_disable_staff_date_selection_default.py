"""Flip Outlet.allow_staff_date_selection to disabled by default.

Staff being able to back-date entries is an exception, not the norm — the
owner opts an outlet into it via Settings, not the other way around. Resets
every existing outlet to match (nobody has deliberately relied on this
being on by default; the owner-facing toggle survives in Settings for
whoever genuinely needs it).
"""
from django.db import migrations, models


def disable_existing(apps, schema_editor):
    Outlet = apps.get_model("catalog", "Outlet")
    Outlet.objects.update(allow_staff_date_selection=False)


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0016_alter_ingredient_bundle_size"),
    ]

    operations = [
        migrations.AlterField(
            model_name="outlet",
            name="allow_staff_date_selection",
            field=models.BooleanField(
                default=False,
                help_text="Let staff choose which date to log operations for (e.g. back-entering yesterday's data).",
            ),
        ),
        migrations.RunPython(disable_existing, migrations.RunPython.noop),
    ]
