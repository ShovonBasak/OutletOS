from django.db import migrations, models

DEFAULT_ORG_SLUG = "cp-five-star"


def consolidate_to_one_org(apps, schema_editor):
    """The catalog (Product, Ingredient) is becoming global — every CP Five
    Star franchise sells the same menu, so there's no reason for it to be
    org-scoped. Before dropping the `organization` field, pick ONE
    organization's rows as the single source of truth and drop any other
    organization's catalog rows, so we don't end up with duplicate/orphaned
    products and ingredients once the field is gone.

    Preference: the pre-existing single-tenant org (slug=cp-five-star, the
    org every earlier backfill migration anchored on). Falls back to
    whichever organization has the most catalog rows if that slug is
    missing. A no-op if there's only one organization (the common case)."""
    Organization = apps.get_model("catalog", "Organization")
    Product = apps.get_model("catalog", "Product")
    Ingredient = apps.get_model("catalog", "Ingredient")

    orgs = list(Organization.objects.all())
    if len(orgs) <= 1:
        return

    keeper = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()
    if keeper is None:
        keeper = max(
            orgs,
            key=lambda o: Product.objects.filter(organization=o).count()
            + Ingredient.objects.filter(organization=o).count(),
        )

    for org in orgs:
        if org.id == keeper.id:
            continue
        # Deleting Products first cascades away that org's Recipe,
        # ComboComponent, RecipeProductComponent, and ProductPrice rows, so
        # the Ingredient delete below never hits a Recipe.ingredient PROTECT.
        Product.objects.filter(organization=org).delete()
        Ingredient.objects.filter(organization=org).delete()


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0012_onboarding_and_tenant_application"),
    ]

    operations = [
        migrations.RunPython(consolidate_to_one_org, noop),
        migrations.RemoveField(
            model_name="product",
            name="organization",
        ),
        migrations.RemoveField(
            model_name="ingredient",
            name="organization",
        ),
    ]
