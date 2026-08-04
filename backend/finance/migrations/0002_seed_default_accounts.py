import datetime
from django.db import migrations


DEFAULTS = [
    {"account_type": "CASH", "name": "Shop Cash", "provider": ""},
    {"account_type": "MOBILE_WALLET", "name": "bKash Merchant", "provider": "bKash"},
    {"account_type": "BANK", "name": "Business Bank Account", "provider": ""},
    {"account_type": "SUPPLIER_CREDIT", "name": "CP/NKG Supplier Credit", "provider": "CP/NKG"},
]


def seed_accounts(apps, schema_editor):
    FinancialAccount = apps.get_model("finance", "FinancialAccount")
    Outlet = apps.get_model("catalog", "Outlet")

    if FinancialAccount.objects.exists():
        return

    outlet = Outlet.objects.first()
    opening_date = datetime.date(2026, 7, 1)

    for d in DEFAULTS:
        FinancialAccount.objects.create(
            outlet=outlet,
            account_type=d["account_type"],
            name=d["name"],
            provider=d["provider"],
            opening_balance=0,
            opening_balance_date=opening_date,
            is_active=True,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0001_initial"),
        ("catalog", "0007_ingredient_group"),
    ]

    operations = [
        migrations.RunPython(seed_accounts, migrations.RunPython.noop),
    ]
