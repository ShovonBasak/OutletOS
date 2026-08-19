from django.db import migrations


def seed_electricity(apps, schema_editor):
    CostCategory = apps.get_model("costs", "CostCategory")
    CostCategory.objects.get_or_create(name="Electricity", defaults={"cost_type": "VARIABLE"})


class Migration(migrations.Migration):
    dependencies = [
        ("costs", "0002_seed_default_categories"),
    ]

    operations = [
        migrations.RunPython(seed_electricity, migrations.RunPython.noop),
    ]
