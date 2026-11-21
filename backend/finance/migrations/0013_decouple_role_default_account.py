"""Split "default account per role" out of AccountRoleAccess into its own model.

AccountRoleAccess.is_default (added in 0012) turned out to be the wrong
place for this: that table's mere existence for a role means "restrict this
role to only these accounts," so recording a default there forces a role
into restricted mode even if nobody asked for one — which is exactly what
happened in practice (OWNER had zero restriction rows, i.e. every account
visible; adding one row just to carry is_default=True on Owner Cash
silently cut every owner down to seeing only that one account everywhere
AccountRoleAccess is consulted). RoleDefaultAccount is independent of
restriction and has organization as a direct field, so "one default per
org per role" is a real unique constraint rather than enforced in code.

Migrates any existing is_default=True rows over before dropping the field.
"""
import django.db.models.deletion
from django.db import migrations, models


def migrate_existing_defaults(apps, schema_editor):
    AccountRoleAccess = apps.get_model("finance", "AccountRoleAccess")
    RoleDefaultAccount = apps.get_model("finance", "RoleDefaultAccount")

    for row in AccountRoleAccess.objects.filter(is_default=True).select_related("account"):
        RoleDefaultAccount.objects.update_or_create(
            organization_id=row.account.organization_id, role=row.role,
            defaults={"account_id": row.account_id},
        )


class Migration(migrations.Migration):

    dependencies = [
        ('catalog', '0017_disable_staff_date_selection_default'),
        ('finance', '0012_accountroleaccess_is_default'),
    ]

    operations = [
        migrations.CreateModel(
            name='RoleDefaultAccount',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('role', models.CharField(choices=[('STAFF', 'Staff'), ('OWNER', 'Owner'), ('ADMIN', 'Admin')], max_length=10)),
                ('account', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='default_for_roles', to='finance.financialaccount')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='role_default_accounts', to='catalog.organization')),
            ],
            options={
                'unique_together': {('organization', 'role')},
            },
        ),
        migrations.RunPython(migrate_existing_defaults, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name='accountroleaccess',
            name='is_default',
        ),
    ]
