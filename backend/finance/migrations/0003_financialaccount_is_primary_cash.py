from django.db import migrations, models


def set_default_primary_cash(apps, schema_editor):
    """Auto-mark the first active CASH account as primary so existing data keeps working."""
    FinancialAccount = apps.get_model("finance", "FinancialAccount")
    first_cash = FinancialAccount.objects.filter(
        account_type="CASH", is_active=True
    ).order_by("id").first()
    if first_cash:
        first_cash.is_primary_cash = True
        first_cash.save(update_fields=["is_primary_cash"])


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0002_seed_default_accounts"),
    ]

    operations = [
        migrations.AddField(
            model_name="financialaccount",
            name="is_primary_cash",
            field=models.BooleanField(
                default=False,
                help_text="Marks this as the shop's main cash account.",
            ),
        ),
        migrations.RunPython(set_default_primary_cash, migrations.RunPython.noop),
    ]
