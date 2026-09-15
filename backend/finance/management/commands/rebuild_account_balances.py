"""Repair tool: full replay of one or all FinancialAccount balance histories.

Wraps finance.services.rebuild_account_balances — the same function backing
the owner's "Recalculate balances" button and the automatic rebuild triggered
when opening_balance changes. Useful after a manual DB fix, or just to
confirm the ledger is internally consistent.

Dry-run by default (prints what would change per account). Pass --apply to commit.
"""
from django.core.management.base import BaseCommand

from finance.models import FinancialAccount
from finance.services import rebuild_account_balances


class Command(BaseCommand):
    help = "Recompute balance_before/balance_after for one or all financial accounts."

    def add_arguments(self, parser):
        parser.add_argument("--account", type=int, help="Only this account id. Default: all accounts.")
        parser.add_argument("--apply", action="store_true", help="Commit changes. Default is dry-run (preview only).")

    def handle(self, *args, **options):
        apply_changes = options["apply"]
        qs = FinancialAccount.objects.all()
        if options.get("account"):
            qs = qs.filter(pk=options["account"])
            if not qs.exists():
                self.stderr.write(f"No account with id={options['account']}")
                return

        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                "[DRY RUN] rebuild_account_balances always commits atomically per "
                "account (there's no partial-apply step to preview) — this will "
                "just report what a real run would change. Pass --apply to run it.\n"
            ))

        total_changed = 0
        for account in qs:
            if apply_changes:
                result = rebuild_account_balances(account.id)
            else:
                # Dry-run: replay in memory without writing, by calling the same
                # logic pattern here rather than mutating via the service.
                running = account.opening_balance
                changed = 0
                for txn in account.transactions.order_by("date", "id"):
                    before, running = running, running + txn.amount
                    if txn.balance_before != before or txn.balance_after != running:
                        changed += 1
                result = {"account_id": account.id, "checked": account.transactions.count(), "changed": changed}

            total_changed += result["changed"]
            marker = "no changes" if result["changed"] == 0 else f"{result['changed']} row(s) changed"
            self.stdout.write(f"  {account.name}: {result['checked']} transaction(s) checked, {marker}")

        self.stdout.write("")
        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                f"[DRY RUN] {total_changed} row(s) would change across {qs.count()} account(s)."
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                f"Applied: {total_changed} row(s) changed across {qs.count()} account(s)."
            ))
