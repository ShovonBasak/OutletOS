"""Recompute DisplayStock for a given operating day from prep logs.

Usage:
    python manage.py recompute_display_stock            # today
    python manage.py recompute_display_stock 2026-08-15 # specific date

For each prepared product, DS is set to:
    sum(pieces_prepared for FRESH + CARRIED_FORWARD logs on that date)
    minus closing deductions already applied (available - remains from a LOCKED closing).

Safe to run on a DRAFT closing: no deductions have been applied yet so DS
simply equals the sum of the day's prep logs.
"""
from datetime import date as date_cls

from django.core.management.base import BaseCommand
from django.db.models import Q, Sum
from django.utils import timezone

from catalog.models import Product
from closing.models import ClosingStatus, DailyClosing
from stock.models import DisplayStock, PreparationLog


class Command(BaseCommand):
    help = "Recompute DisplayStock from prep logs for a given date."

    def add_arguments(self, parser):
        parser.add_argument(
            "date",
            nargs="?",
            default=None,
            help="Operating date (YYYY-MM-DD). Defaults to today.",
        )
        parser.add_argument(
            "--outlet",
            type=int,
            default=1,
            help="Outlet ID (default: 1).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print what would change without writing to the DB.",
        )

    def handle(self, *args, **options):
        op_date = options["date"] or str(timezone.localdate())
        outlet_id = options["outlet"]
        dry_run = options["dry_run"]

        self.stdout.write(f"Recomputing DS for outlet={outlet_id} date={op_date}")

        # Sum prep log pieces per product for this date.
        preps = (
            PreparationLog.objects.filter(
                outlet_id=outlet_id,
            )
            .filter(
                Q(op_date=op_date) | Q(op_date__isnull=True, timestamp__date=op_date)
            )
            .values("product_id")
            .annotate(total=Sum("pieces_prepared"))
        )
        prep_map = {row["product_id"]: row["total"] or 0 for row in preps}

        # If the day's closing is LOCKED, _close_operating_day already deducted
        # (available - remains) from DS. Subtract that from our expected value.
        deducted_map = {}
        closing = (
            DailyClosing.objects.filter(outlet_id=outlet_id, closing_date=op_date)
            .prefetch_related("stock_counts")
            .first()
        )
        if closing and closing.status == ClosingStatus.LOCKED:
            for count in closing.stock_counts.all():
                deduct = count.available_pieces - count.remains_pieces
                if deduct > 0:
                    deducted_map[count.product_id] = deduct
            self.stdout.write("  Closing is LOCKED — accounting for deductions.")
        elif closing:
            self.stdout.write(f"  Closing status: {closing.status} — no deductions applied yet.")
        else:
            self.stdout.write("  No closing record found — no deductions.")

        # Apply corrections for prepared products only.
        products = Product.objects.filter(requires_preparation=True, is_active=True)
        changed = 0
        for product in products:
            expected = prep_map.get(product.id, 0) - deducted_map.get(product.id, 0)
            expected = max(0, expected)

            ds = DisplayStock.objects.filter(outlet_id=outlet_id, product=product).first()
            current = ds.pieces_available if ds else 0

            if current == expected:
                continue

            self.stdout.write(
                f"  {product.name}: {current} → {expected} "
                f"(preps={prep_map.get(product.id,0)}, deducted={deducted_map.get(product.id,0)})"
            )
            if not dry_run:
                obj, _ = DisplayStock.objects.get_or_create(outlet_id=outlet_id, product=product)
                obj.pieces_available = expected
                obj.save(update_fields=["pieces_available"])
                changed += 1

        if dry_run:
            self.stdout.write("Dry run — no changes written.")
        else:
            self.stdout.write(self.style.SUCCESS(f"Done. {changed} DisplayStock row(s) corrected."))
