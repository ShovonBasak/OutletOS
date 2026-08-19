"""
Backfill PeriodicStockCheck history using stock-in data.

Context: The Aug 18 2026 periodic counts were the FIRST ever checks.
Because no previous check existed, the system recorded stock_in_since=0
and computed consumed = 0 - counted (negative — meaningless).

This command reconstructs a proper ledger by:
  1. Computing total_consumed = Σ stock_in_qty − final_counted_qty for each ingredient.
  2. Distributing that consumption uniformly over the full span
     (first stock-in date → Aug 18) as a daily rate.
  3. Creating a synthetic PeriodicStockCheck at each stock-in date (before Aug 18)
     showing the inferred running balance.
  4. Updating the Aug 18 check to reflect stock received and consumed since the
     last synthetic check.

Usage:
    python manage.py backfill_periodic_history [--dry-run] [--anchor-date 2026-08-18]
"""

from datetime import date, datetime, time
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Sum, Q
from django.utils.timezone import make_aware

from catalog.models import Ingredient
from stock.models import PeriodicStockCheck, StockInItem, StockInRecord


class Command(BaseCommand):
    help = "Backfill PeriodicStockCheck history from stock-in data using uniform daily rate."

    def add_arguments(self, parser):
        parser.add_argument(
            "--anchor-date",
            default="2026-08-18",
            help="The date of the existing counted checks to anchor against (default: 2026-08-18).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print what would happen without writing anything.",
        )

    def handle(self, *args, **options):
        anchor_date = date.fromisoformat(options["anchor_date"])
        dry_run = options["dry_run"]

        if dry_run:
            self.stdout.write(self.style.WARNING("DRY RUN — no changes will be written.\n"))

        periodic_ingredients = Ingredient.objects.filter(
            tracking_mode="PERIODIC_COUNT", is_active=True
        )

        with transaction.atomic():
            for ingredient in periodic_ingredients:
                self._process(ingredient, anchor_date, dry_run)

            if dry_run:
                transaction.set_rollback(True)

        if not dry_run:
            self.stdout.write(self.style.SUCCESS("\nDone."))

    def _process(self, ingredient, anchor_date, dry_run):
        self.stdout.write(f"\n── {ingredient.name} ──")

        # The single anchor check (Aug 18)
        try:
            anchor_check = PeriodicStockCheck.objects.get(
                ingredient=ingredient,
                checked_at__date=anchor_date,
            )
        except PeriodicStockCheck.DoesNotExist:
            self.stdout.write(f"  No anchor check on {anchor_date}, skipping.")
            return
        except PeriodicStockCheck.MultipleObjectsReturned:
            self.stdout.write(
                self.style.WARNING(f"  Multiple checks on {anchor_date}, skipping.")
            )
            return

        final_counted = anchor_check.counted_qty
        checked_by = anchor_check.checked_by
        outlet = anchor_check.outlet

        # Delete existing synthetic checks (if re-running) — keep only the anchor
        PeriodicStockCheck.objects.filter(
            ingredient=ingredient,
            outlet=outlet,
            note__startswith="[synthetic]",
        ).delete()

        # Collect all approved stock-in quantities per date up to anchor
        stock_in_rows = (
            StockInItem.objects.filter(
                ingredient=ingredient,
                stock_in_record__status="APPROVED",
                stock_in_record__outlet=outlet,
                stock_in_record__stock_in_date__lte=anchor_date,
            )
            .select_related("stock_in_record", "pack_definition")
            .order_by("stock_in_record__stock_in_date")
        )

        # Build date → qty map (in base units)
        date_qty: dict[date, Decimal] = {}
        for item in stock_in_rows:
            d = item.stock_in_record.stock_in_date
            qty = (
                item.confirmed_quantity * item.pack_definition.pieces_per_pack
                if item.unit_captured == "PACK" and item.pack_definition_id
                else item.confirmed_quantity
            )
            date_qty[d] = date_qty.get(d, Decimal("0")) + qty

        if not date_qty:
            self.stdout.write("  No approved stock-in records, skipping.")
            return

        sorted_dates = sorted(date_qty.keys())
        first_date = sorted_dates[0]
        total_received = sum(date_qty.values(), Decimal("0"))
        total_consumed = total_received - final_counted

        total_days = (anchor_date - first_date).days

        self.stdout.write(
            f"  First stock-in: {first_date}  |  Total received: {total_received}  "
            f"|  Final count: {final_counted}  |  Total consumed: {total_consumed}  "
            f"|  Span: {total_days} days"
        )

        if total_days == 0:
            self.stdout.write("  Span is 0 days, nothing to distribute.")
            return

        if total_consumed < 0:
            self.stdout.write(
                self.style.WARNING(
                    f"  Counted ({final_counted}) exceeds total received ({total_received}). "
                    "Setting consumed=0 (initial stock or data gap)."
                )
            )
            total_consumed = Decimal("0")

        daily_rate = total_consumed / Decimal(total_days)
        self.stdout.write(f"  Daily rate: {daily_rate:.4f} {ingredient.base_unit}/day")

        # Walk through stock-in dates before anchor and create synthetic checks
        cumulative_received = Decimal("0")
        prev_date = first_date
        prev_balance: Decimal | None = None  # balance after previous synthetic check

        synthetic_dates = [d for d in sorted_dates if d < anchor_date]

        for d in synthetic_dates:
            qty_on_day = date_qty[d]
            cumulative_received += qty_on_day

            days_from_start = (d - first_date).days
            inferred_balance = cumulative_received - daily_rate * Decimal(days_from_start)
            inferred_balance = max(Decimal("0"), inferred_balance)

            if prev_balance is None:
                # First ever check: stock_in_since = qty received today
                stock_in_since = qty_on_day
                consumed_since = Decimal("0")  # by definition — it's day 0
            else:
                stock_in_since = qty_on_day
                # consumed between prev synthetic check and this one
                consumed_since = daily_rate * Decimal((d - prev_date).days)

            self.stdout.write(
                f"  → {d}  received={qty_on_day}  "
                f"stock_in_since={stock_in_since:.3f}  "
                f"consumed_since={consumed_since:.3f}  "
                f"balance={inferred_balance:.3f}"
            )

            if not dry_run:
                check = PeriodicStockCheck(
                    outlet=outlet,
                    ingredient=ingredient,
                    checked_by=checked_by,
                    counted_qty=inferred_balance,
                    stock_in_since_last_check=stock_in_since,
                    consumed_since_last_check=consumed_since,
                    note=f"[synthetic] Backfilled {anchor_date}. Uniform daily rate {daily_rate:.4f}/day.",
                )
                check.save()
                # Override auto_now_add to noon on the actual stock-in date
                PeriodicStockCheck.objects.filter(pk=check.pk).update(
                    checked_at=make_aware(datetime.combine(d, time(12, 0)))
                )

            prev_date = d
            prev_balance = inferred_balance

        # Update the anchor (Aug 18) check
        # stock_in_since = any stock received on Aug 18 itself
        anchor_stock_in = date_qty.get(anchor_date, Decimal("0"))
        consumed_since_last = daily_rate * Decimal((anchor_date - prev_date).days)

        self.stdout.write(
            f"  → {anchor_date} (ANCHOR)  "
            f"stock_in_since={anchor_stock_in:.3f}  "
            f"consumed_since={consumed_since_last:.3f}  "
            f"counted={final_counted}"
        )

        if not dry_run:
            anchor_check.stock_in_since_last_check = anchor_stock_in
            anchor_check.consumed_since_last_check = consumed_since_last
            anchor_check.save(
                update_fields=["stock_in_since_last_check", "consumed_since_last_check"]
            )
