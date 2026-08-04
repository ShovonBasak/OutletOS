from django.db import migrations


def seed_categories(apps, schema_editor):
    CostCategory = apps.get_model("costs", "CostCategory")
    CostCategory.objects.get_or_create(name="Services", defaults={"cost_type": "VARIABLE"})
    CostCategory.objects.get_or_create(name="Others", defaults={"cost_type": "ADHOC"})


def reverse_seed(apps, schema_editor):
    CostCategory = apps.get_model("costs", "CostCategory")
    CostCategory.objects.filter(name__in=["Services", "Others"]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("costs", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_categories, reverse_seed),
    ]
