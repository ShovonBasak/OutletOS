from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"


def backfill(apps, schema_editor):
    Organization = apps.get_model("catalog", "Organization")
    User = apps.get_model("accounts", "User")

    org = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()
    if not org:
        return

    # ADMIN is the platform-admin role and stays organization=None (cross-org).
    User.objects.filter(organization__isnull=True).exclude(role="ADMIN").update(organization=org)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0005_user_organization"),
        ("catalog", "0009_backfill_organization"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
