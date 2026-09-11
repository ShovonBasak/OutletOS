from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"


def backfill(apps, schema_editor):
    Organization = apps.get_model("catalog", "Organization")
    FinancialAccount = apps.get_model("finance", "FinancialAccount")

    org = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()
    if not org:
        return
    FinancialAccount.objects.filter(organization__isnull=True).update(organization=org)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0006_financialaccount_organization"),
        ("catalog", "0009_backfill_organization"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
