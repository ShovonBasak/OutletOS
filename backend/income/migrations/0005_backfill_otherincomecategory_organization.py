from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"


def backfill(apps, schema_editor):
    Organization = apps.get_model("catalog", "Organization")
    OtherIncomeCategory = apps.get_model("income", "OtherIncomeCategory")

    org = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()
    if not org:
        return
    OtherIncomeCategory.objects.filter(organization__isnull=True).update(organization=org)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("income", "0004_otherincomecategory_organization"),
        ("catalog", "0009_backfill_organization"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
