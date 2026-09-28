from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"


def consolidate_to_one_org(apps, schema_editor):
    """OtherIncomeCategory is becoming global — see catalog.migrations
    0013_globalize_catalog for the same pattern/reasoning. No-op if there's
    only one organization (the common case)."""
    Organization = apps.get_model("catalog", "Organization")
    OtherIncomeCategory = apps.get_model("income", "OtherIncomeCategory")

    orgs = list(Organization.objects.all())
    if len(orgs) <= 1:
        return

    keeper = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()
    if keeper is None:
        keeper = max(orgs, key=lambda o: OtherIncomeCategory.objects.filter(organization=o).count())

    for org in orgs:
        if org.id == keeper.id:
            continue
        OtherIncomeCategory.objects.filter(organization=org).delete()


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("income", "0006_require_organization"),
    ]

    operations = [
        migrations.RunPython(consolidate_to_one_org, noop),
        migrations.RemoveField(
            model_name="otherincomecategory",
            name="organization",
        ),
    ]
