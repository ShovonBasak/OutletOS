"""
shift_dates_back — move all operational data back N days for testing.

Usage:
    python manage.py shift_dates_back          # shift back 1 day (default)
    python manage.py shift_dates_back --days 2 # shift back 2 days

Shifts every date/timestamp field on operational tables so that today's
data appears as if it happened N days ago.  Catalog, users, and sales-
channel setup are left untouched.

Use this after completing a test day to simulate the passage of time and
test "start new day" carry-forward / stock-reconciliation flows.
"""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import ExpressionWrapper, F
from django.db.models.fields import DateField, DateTimeField


class Command(BaseCommand):
    help = "Shift all operational date/timestamp fields back N days (default 1). For testing only."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=1,
            help="Number of days to shift back (default: 1)",
        )

    def handle(self, *args, **options):
        days = options["days"]
        delta = timedelta(days=days)

        self.stdout.write(self.style.WARNING(f"Shifting all operational data back {days} day(s)…\n"))

        totals = {}

        # ------------------------------------------------------------------
        # Stock
        # ------------------------------------------------------------------
        from stock.models import (
            OperatingDay,
            StockInRecord,
            PreparationLog,
            PeriodicStockCheck,
        )

        # OperatingDay — date + nullable datetimes
        n = OperatingDay.objects.update(
            date=ExpressionWrapper(F("date") - delta, output_field=DateField()),
            started_at=ExpressionWrapper(F("started_at") - delta, output_field=DateTimeField()),
            stock_confirmed_at=ExpressionWrapper(F("stock_confirmed_at") - delta, output_field=DateTimeField()),
            carry_forward_confirmed_at=ExpressionWrapper(F("carry_forward_confirmed_at") - delta, output_field=DateTimeField()),
        )
        totals["OperatingDay"] = n

        # StockInRecord — date + nullable datetimes (including auto_now_add created_at)
        n = StockInRecord.objects.update(
            stock_in_date=ExpressionWrapper(F("stock_in_date") - delta, output_field=DateField()),
            created_at=ExpressionWrapper(F("created_at") - delta, output_field=DateTimeField()),
            reviewed_at=ExpressionWrapper(F("reviewed_at") - delta, output_field=DateTimeField()),
        )
        totals["StockInRecord"] = n

        # PreparationLog — auto_now_add timestamp
        n = PreparationLog.objects.update(
            timestamp=ExpressionWrapper(F("timestamp") - delta, output_field=DateTimeField()),
        )
        totals["PreparationLog"] = n

        # PeriodicStockCheck — auto_now_add checked_at
        n = PeriodicStockCheck.objects.update(
            checked_at=ExpressionWrapper(F("checked_at") - delta, output_field=DateTimeField()),
        )
        totals["PeriodicStockCheck"] = n

        # ------------------------------------------------------------------
        # Closing
        # ------------------------------------------------------------------
        from closing.models import DailyClosing, ChannelSettlement

        # DailyClosing — closing_date + nullable submitted_at
        n = DailyClosing.objects.update(
            closing_date=ExpressionWrapper(F("closing_date") - delta, output_field=DateField()),
            submitted_at=ExpressionWrapper(F("submitted_at") - delta, output_field=DateTimeField()),
        )
        totals["DailyClosing"] = n

        # ChannelSettlement — three date fields
        n = ChannelSettlement.objects.update(
            period_start=ExpressionWrapper(F("period_start") - delta, output_field=DateField()),
            period_end=ExpressionWrapper(F("period_end") - delta, output_field=DateField()),
            received_date=ExpressionWrapper(F("received_date") - delta, output_field=DateField()),
        )
        totals["ChannelSettlement"] = n

        # ------------------------------------------------------------------
        # Costs
        # ------------------------------------------------------------------
        from costs.models import Expense

        n = Expense.objects.update(
            date=ExpressionWrapper(F("date") - delta, output_field=DateField()),
        )
        totals["Expense"] = n

        # ------------------------------------------------------------------
        # Summary
        # ------------------------------------------------------------------
        self.stdout.write("")
        for model, count in totals.items():
            if count:
                self.stdout.write(f"  {self.style.SUCCESS('✓')}  {model:<22} {count} row(s) shifted")
            else:
                self.stdout.write(f"     {model:<22} (no rows)")

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"Done — all dates moved back {days} day(s)."))
