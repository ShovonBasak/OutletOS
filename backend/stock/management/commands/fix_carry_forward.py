"""
Fix a missing carry-forward for a given operating day.

The carry-forward step may have run and confirmed 0 items when
OperatingDay.daily_closing_id was NULL for the previous day, causing
carry_forward_candidates() to return []. This command:

  1. Links the previous day's OperatingDay to its DailyClosing (if unlinked).
  2. Creates the missing CARRIED_FORWARD PreparationLog rows for the target date.
  3. Updates DisplayStock for each carried-forward product.

Use --dry-run to preview without committing.
Use --date YYYY-MM-DD for the operating day that missed its carry-forward (default: today).
"""

from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone


class Command(BaseCommand):
    help = "Retroactively apply a missed carry-forward for an operating day."

    def add_arguments(self, parser):
        parser.add_argument("--date", help="Operating day that missed carry-forward (YYYY-MM-DD). Default: today.")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        import datetime
        from closing.models import DailyClosing
        from stock.models import (
            OperatingDay, OperatingDayStatus, PreparationLog, PrepSource, DisplayStock,
        )
        from stock.services import previous_operating_day
        from accounts.models import User

        dry_run = options["dry_run"]

        if options.get("date"):
            try:
                fix_date = datetime.date.fromisoformat(options["date"])
            except ValueError:
                self.stderr.write(f"Invalid date: {options['date']}")
                return
        else:
            fix_date = datetime.date.today()

        op_day = OperatingDay.objects.filter(date=fix_date).first()
        if not op_day:
            self.stdout.write(f"No OperatingDay found for {fix_date}.")
            return

        if op_day.status == OperatingDayStatus.NOT_STARTED:
            self.stdout.write("Day not started yet — nothing to fix.")
            return

        # Step 1: find and link the previous day's closing if unlinked.
        prev_day = previous_operating_day(op_day.outlet, fix_date)
        if not prev_day:
            self.stdout.write("No previous operating day found.")
            return

        if not prev_day.daily_closing_id:
            prev_closing = DailyClosing.objects.filter(
                outlet=prev_day.outlet,
                closing_date=prev_day.date,
            ).first()
            if prev_closing:
                self.stdout.write(
                    f"Linking {prev_day.date} OperatingDay → DailyClosing #{prev_closing.pk}"
                )
                if not dry_run:
                    prev_day.daily_closing = prev_closing
                    prev_day.save(update_fields=["daily_closing"])
            else:
                self.stdout.write(f"No DailyClosing found for {prev_day.date}. Cannot proceed.")
                return
        else:
            prev_closing = prev_day.daily_closing

        # Step 2: find stock counts with remains > 0 for prep products on previous day.
        candidates = prev_closing.stock_counts.filter(
            remains_pieces__gt=0,
            product__requires_preparation=True,
        ).select_related("product")

        if not candidates.exists():
            self.stdout.write(f"No prep remains on {prev_day.date}. Nothing to carry forward.")
            return

        self.stdout.write(f"\nProducts to carry forward into {fix_date}:")

        # Pick a system user (or any staff user) for logging.
        system_user = (
            User.objects.filter(is_staff=True).first()
            or User.objects.first()
        )

        total_carried = 0

        for count in candidates:
            pieces = count.remains_pieces
            self.stdout.write(f"  {count.product.name}: {pieces} pcs")

            # Check if a CARRIED_FORWARD log already exists for this product+date
            existing = PreparationLog.objects.filter(
                outlet=op_day.outlet,
                source=PrepSource.CARRIED_FORWARD,
                op_date=fix_date,
                product=count.product,
            ).first()
            if existing:
                self.stdout.write(f"    → already has CF log ({existing.pieces_prepared} pcs), skipping")
                continue

            if not dry_run:
                with transaction.atomic():
                    PreparationLog.objects.create(
                        outlet=op_day.outlet,
                        logged_by=system_user,
                        product=count.product,
                        source=PrepSource.CARRIED_FORWARD,
                        carried_forward_from=count,
                        leftover_available_pieces=pieces,
                        pieces_prepared=pieces,
                        wastage_pieces=0,
                        op_date=fix_date,
                    )
                    DisplayStock.adjust(op_day.outlet, count.product, pieces)
                    self.stdout.write(f"    → created CF log, DisplayStock +{pieces}")

            total_carried += 1

        if total_carried == 0:
            self.stdout.write("\nAll products already had carry-forward logs.")
        elif dry_run:
            self.stdout.write(f"\n[DRY RUN] {total_carried} product(s) would be carried forward.\n")
        else:
            self.stdout.write(self.style.SUCCESS(f"\nCarried forward {total_carried} product(s).\n"))
