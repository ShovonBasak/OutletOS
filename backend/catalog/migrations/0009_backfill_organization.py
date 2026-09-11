from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"
DEFAULT_ORG_NAME = "CP Five Star"


def backfill(apps, schema_editor):
    Organization = apps.get_model("catalog", "Organization")
    Outlet = apps.get_model("catalog", "Outlet")
    Product = apps.get_model("catalog", "Product")
    Ingredient = apps.get_model("catalog", "Ingredient")

    org, _ = Organization.objects.get_or_create(
        slug=DEFAULT_ORG_SLUG, defaults={"name": DEFAULT_ORG_NAME}
    )

    Outlet.objects.filter(organization__isnull=True).update(organization=org)
    Product.objects.filter(organization__isnull=True).update(organization=org)
    Ingredient.objects.filter(organization__isnull=True).update(organization=org)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0008_organization_ingredient_organization_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
