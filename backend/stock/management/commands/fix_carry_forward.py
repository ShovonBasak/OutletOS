"""
Fix a missing carry-forward for a given operating day.

The carry-forward step may have found no candidates because either:
  a) the immediate previous day's OperatingDay had an unlinked DailyClosing, or
  b) the immediate previous day never operated at all (force-closed via
     "Skip this day") and carry_forward_candidates() stopped there instead of
     reaching further back to the last day that actually has a closing.

This command:
  1. Links the immediate previous day's OperatingDay to its DailyClosing (if unlinked).
  2. Walks back to the last day with a real closing (skipping any skipped days).
  3. Creates the missing CARRIED_FORWARD PreparationLog rows for the target date.
  4. Updates DisplayStock for each carried-forward product.

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
        from stock.services import previous_operating_day, previous_closing_day
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

        # Step 1: find and link the immediate previous day's closing if unlinked
        # (repairs a broken FK — distinct from the "day never operated" case below).
        immediate_prev = previous_operating_day(op_day.outlet, fix_date)
        if immediate_prev and not immediate_prev.daily_closing_id:
            unlinked_closing = DailyClosing.objects.filter(
                outlet=immediate_prev.outlet,
                closing_date=immediate_prev.date,
            ).first()
            if unlinked_closing:
                self.stdout.write(
                    f"Linking {immediate_prev.date} OperatingDay → DailyClosing #{unlinked_closing.pk}"
                )
                if not dry_run:
                    immediate_prev.daily_closing = unlinked_closing
                    immediate_prev.save(update_fields=["daily_closing"])

        # Step 2: walk back to the last day with a real closing, skipping any
        # intervening days that were skipped/never operated (no daily_closing).
        prev_day = previous_closing_day(op_day.outlet, fix_date)
        if not prev_day:
            self.stdout.write("No previous day with a closing found.")
            return
        prev_closing = prev_day.daily_closing
        if prev_day.date != fix_date - datetime.timedelta(days=1):
            self.stdout.write(f"(Nearest previous closing is {prev_day.date} — days in between never operated.)")

        # Step 3: find stock counts with remains > 0 for prep products on that day.
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
