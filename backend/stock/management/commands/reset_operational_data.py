"""
Management command: reset_operational_data

Deletes all day-to-day operational records and resets running balances to zero,
leaving the catalog (products, ingredients, recipes, pack definitions, aliases,
pricing, channels, cost categories, outlets, and user accounts) intact.

Usage:
    python manage.py reset_operational_data            # dry-run (shows counts)
    python manage.py reset_operational_data --confirm  # actually deletes
"""

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = "Delete all operational data; keep catalog, pricing, channels, and accounts."

    def add_arguments(self, parser):
        parser.add_argument(
            "--confirm",
            action="store_true",
            help="Actually perform the deletion. Without this flag the command is a dry-run.",
        )

    def handle(self, *args, **options):
        # Import here to avoid circular-import issues at module load time.
        from closing.models import (
            ChannelSettlement,
            DailyChannelDiscount,
            DailyClosing,
            DailyClosingSalesLine,
            DailyClosingStockCount,
            PaymentEntry,
        )
        from costs.models import Expense
        from stock.models import (
            DayStartStockCheck,
            DisplayStock,
            OperatingDay,
            PeriodicStockCheck,
            PreparationLog,
            RawStock,
            StockInItem,
            StockInRecord,
        )

        # Ordered so that child rows are deleted before parents.
        targets = [
            # Closing sub-rows
            ("ChannelSettlement",      ChannelSettlement),
            ("PaymentEntry",           PaymentEntry),
            ("DailyChannelDiscount",   DailyChannelDiscount),
            ("DailyClosingSalesLine",  DailyClosingSalesLine),
            ("DailyClosingStockCount", DailyClosingStockCount),
            ("DailyClosing",           DailyClosing),
            # Stock operations
            ("Expense",                Expense),
            ("PeriodicStockCheck",     PeriodicStockCheck),
            ("PreparationLog",         PreparationLog),
            ("DisplayStock",           DisplayStock),
            ("StockInItem",            StockInItem),
            ("StockInRecord",          StockInRecord),
            ("RawStock",               RawStock),
            # Operating day (and its stock checks via CASCADE)
            ("DayStartStockCheck",     DayStartStockCheck),
            ("OperatingDay",           OperatingDay),
        ]

        self.stdout.write("\n=== Operational data reset ===\n")

        counts = {label: model.objects.count() for label, model in targets}
        total = sum(counts.values())

        for label, _ in targets:
            n = counts[label]
            color = self.style.WARNING if n else self.style.SUCCESS
            self.stdout.write(f"  {label:<28} {color(str(n))} rows")

        self.stdout.write(f"\n  Total rows to delete: {self.style.WARNING(str(total))}\n")

        if not options["confirm"]:
            self.stdout.write(
                self.style.NOTICE(
                    "Dry-run complete. Re-run with --confirm to actually delete.\n"
                )
            )
            return

        confirm = input(
            "\n⚠  This will permanently delete all operational data. Type YES to continue: "
        )
        if confirm.strip() != "YES":
            self.stdout.write(self.style.ERROR("Aborted.\n"))
            return

        with transaction.atomic():
            for label, model in targets:
                deleted, _ = model.objects.all().delete()
                self.stdout.write(f"  Deleted {deleted:>5} {label} row(s)")

        self.stdout.write(
            self.style.SUCCESS(
                "\nDone. Catalog, pricing, channels, cost categories, "
                "outlets, and user accounts are untouched.\n"
            )
        )
