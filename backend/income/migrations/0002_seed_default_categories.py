from django.db import migrations


def seed_categories(apps, schema_editor):
    OtherIncomeCategory = apps.get_model("income", "OtherIncomeCategory")
    for name in ["Sauce", "Used oil sale", "Recyclables", "Others"]:
        OtherIncomeCategory.objects.get_or_create(name=name)


def reverse_seed(apps, schema_editor):
    OtherIncomeCategory = apps.get_model("income", "OtherIncomeCategory")
    OtherIncomeCategory.objects.filter(name__in=["Used oil sale", "Recyclables", "Others"]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("income", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_categories, reverse_seed),
    ]
