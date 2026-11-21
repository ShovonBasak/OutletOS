"""Add running-balance tracking to AccountTransaction.

balance_before / balance_after are added with a one-off default of 0 (required
for the AddField on a non-nullable column with existing rows), then
immediately backfilled by replaying each account's transaction history in
LEDGER ORDER — (date, id) ascending — from opening_balance forward. This is
the same algorithm finance.services.rebuild_account_balances uses, but
reimplemented self-contained here (via apps.get_model) rather than imported,
since app code is free to keep evolving after this migration is frozen in
history.

created_at (real insertion timestamp, audit/display only — not used in
balance math) is backfilled for historical rows as `date` at midnight: a
best-effort approximation, since the true original entry time was never
recorded. Every row created after this migration gets a real timestamp via
the model's `default=timezone.now`.

Defensive against databases descended from `prod`, which added this exact
column trio under a different migration (it predates the org-scoping work
this branch forked for). AddFieldIfMissing checks the real column before
acting; if it's already there, the whole backfill is skipped too — not just
the AddField — because re-running it would overwrite real, since-accumulated
`created_at` timestamps with the historical midnight approximation.
balance_before/balance_after are always safely re-derivable from the ledger,
but created_at is not, so "were these columns missing before this migration
touched anything" is captured once (by the first AddFieldIfMissing, before
any of the three have run) and reused by the backfill's skip check too.
"""
from datetime import datetime, time

from django.db import migrations, models
from django.utils import timezone


def _column_exists(schema_editor, table_name, column_name):
    with schema_editor.connection.cursor() as cursor:
        columns = schema_editor.connection.introspection.get_table_description(cursor, table_name)
    return any(c.name == column_name for c in columns)


# Captured once, by the first AddFieldIfMissing below, before anything in
# this migration has had a chance to add a column itself.
_state = {}


class AddFieldIfMissing(migrations.AddField):
    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        to_model = to_state.apps.get_model(app_label, self.model_name)
        pre_existing = _column_exists(schema_editor, to_model._meta.db_table, self.name)
        if "pre_existing" not in _state:
            _state["pre_existing"] = pre_existing
        if pre_existing:
            return
        super().database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        pass  # one-off reconciliation migration — reverse not supported


def backfill_balances(apps, schema_editor):
    if _state.get("pre_existing"):
        return  # prod's parallel history already added + backfilled these
    FinancialAccount = apps.get_model("finance", "FinancialAccount")
    AccountTransaction = apps.get_model("finance", "AccountTransaction")

    for account in FinancialAccount.objects.all():
        running = account.opening_balance
        rows = []
        for txn in account.transactions.order_by("date", "id"):
            txn.balance_before = running
            running = running + txn.amount
            txn.balance_after = running
            txn.created_at = timezone.make_aware(datetime.combine(txn.date, time.min))
            rows.append(txn)
        if rows:
            AccountTransaction.objects.bulk_update(
                rows, ["balance_before", "balance_after", "created_at"], batch_size=500
            )


class Migration(migrations.Migration):

    dependencies = [
        ("finance", "0008_require_organization"),
    ]

    operations = [
        AddFieldIfMissing(
            model_name="accounttransaction",
            name="balance_before",
            field=models.DecimalField(max_digits=14, decimal_places=2, default=0),
            preserve_default=False,
        ),
        AddFieldIfMissing(
            model_name="accounttransaction",
            name="balance_after",
            field=models.DecimalField(max_digits=14, decimal_places=2, default=0),
            preserve_default=False,
        ),
        AddFieldIfMissing(
            model_name="accounttransaction",
            name="created_at",
            field=models.DateTimeField(default=timezone.now, editable=False),
        ),
        migrations.RunPython(backfill_balances, migrations.RunPython.noop),
    ]
