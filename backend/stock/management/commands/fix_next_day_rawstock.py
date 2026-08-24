"""
Fix RawStock, DisplayStock, and DayStartStockCheck for a given date when the
previous day's closing incorrectly set RawStock = remains + stock_in for products
whose count was taken AFTER the delivery arrived (so stock_in was already included
in remains and was double-counted).

Correct formula:
  - Count AFTER delivery (remains > day_start): RawStock = remains only
  - Count BEFORE delivery (remains <= day_start): RawStock = remains + stock_in

Run with --date to fix a specific date's opening stock.  Default: yesterday.
Use --dry-run to preview changes without committing.
"""

from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = "Fix RawStock/DisplayStock/DayStartStockCheck when previous-day closing double-counted a mid-day delivery."

    def add_arguments(self, parser):
        parser.add_argument("--date", help="Date to fix opening stock for (YYYY-MM-DD). Default: today.")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        import datetime
        from closing.models import DailyClosing
        from stock.models import (
            StockInItem, StockInStatus, OperatingDay, DayStartStockCheck,
            RawStock, DisplayStock,
        )

        dry_run = options["dry_run"]

        if options.get("date"):
            try:
                fix_date = datetime.date.fromisoformat(options["date"])
            except ValueError:
                self.stderr.write(f"Invalid date: {options['date']}")
                return
        else:
            fix_date = datetime.date.today()

        prev_date = fix_date - datetime.timedelta(days=1)

        prev_closing = DailyClosing.objects.filter(closing_date=prev_date).first()
        if not prev_closing:
            self.stdout.write(f"No closing found for {prev_date}.")
            return

        outlet = prev_closing.outlet
        op_day_prev = OperatingDay.objects.filter(outlet=outlet, date=prev_date).first()
        op_day_fix = OperatingDay.objects.filter(outlet=outlet, date=fix_date).first()

        # Build day_start map for previous day (to detect before/after delivery)
        day_start_map: dict[int, Decimal] = {}
        if op_day_prev:
            for check in DayStartStockCheck.objects.filter(operating_day=op_day_prev):
                day_start_map[check.ingredient_id] = check.confirmed_qty

        # Build stock-in totals for the previous day
        stock_in_items = list(StockInItem.objects.filter(
            stock_in_record__outlet=outlet,
            stock_in_record__stock_in_date=prev_date,
            stock_in_record__status=StockInStatus.APPROVED,
            ingredient__isnull=False,
        ).select_related("ingredient", "pack_definition", "stock_in_record"))

        if not stock_in_items:
            self.stdout.write(f"No approved stock-ins on {prev_date}. Nothing to fix.")
            return

        stock_in_by_ingredient: dict[int, Decimal] = {}
        for item in stock_in_items:
            qty = item.base_unit_quantity()
            stock_in_by_ingredient[item.ingredient_id] = (
                stock_in_by_ingredient.get(item.ingredient_id, Decimal("0")) + qty
            )

        # Build today's (fix_date) stock-in — needed for correct current RawStock
        today_stock_in_by_ingredient: dict[int, Decimal] = {}
        for item in StockInItem.objects.filter(
            stock_in_record__outlet=outlet,
            stock_in_record__stock_in_date=fix_date,
            stock_in_record__status=StockInStatus.APPROVED,
            ingredient__isnull=False,
        ).select_related("ingredient", "pack_definition"):
            qty = item.base_unit_quantity()
            today_stock_in_by_ingredient[item.ingredient_id] = (
                today_stock_in_by_ingredient.get(item.ingredient_id, Decimal("0")) + qty
            )

        # DayStartStockCheck for fix_date (to update system_carried + confirmed)
        day_start_fix: dict[int, DayStartStockCheck] = {}
        if op_day_fix:
            for check in DayStartStockCheck.objects.filter(
                operating_day=op_day_fix
            ).select_related("ingredient"):
                day_start_fix[check.ingredient_id] = check

        total_fixed = 0

        for sc in prev_closing.stock_counts.select_related("product").filter(
            product__requires_preparation=False
        ):
            product = sc.product
            recipes = list(product.recipes.select_related("ingredient").all())
            if not recipes:
                continue

            for recipe in recipes:
                iid = recipe.ingredient_id
                prev_stock_in = stock_in_by_ingredient.get(iid, Decimal("0"))
                if prev_stock_in <= 0:
                    continue

                qty_per = recipe.quantity_per_unit or Decimal("1")
                day_start_ing = day_start_map.get(iid, Decimal("0"))
                day_start_pieces = int(day_start_ing / qty_per)

                count_after_delivery = sc.remains_pieces > day_start_pieces
                if not count_after_delivery:
                    continue  # before-delivery case was handled correctly

                overcount = prev_stock_in  # stock_in that was incorrectly double-added
                correct_opening = Decimal(sc.remains_pieces) * qty_per

                # Current RawStock = correct_opening + any fix_date stock-in
                # (because today's stock-in was approved on top of the inflated base)
                fix_date_si = today_stock_in_by_ingredient.get(iid, Decimal("0"))
                correct_rawstock = correct_opening + fix_date_si

                rs = RawStock.objects.filter(outlet=outlet, ingredient=recipe.ingredient).first()
                raw_now = rs.quantity_available if rs else Decimal("0")

                check_fix = day_start_fix.get(iid)
                sys_now = check_fix.system_carried_qty if check_fix else None

                self.stdout.write(
                    f"\n  {product.name}  (ingredient: {recipe.ingredient.name})"
                    f"\n    Prev-day remains={sc.remains_pieces}, prev-day stock_in={int(prev_stock_in / qty_per)} pcs"
                    f"\n    Opening overcount: {int(overcount / qty_per)} pcs"
                )
                if check_fix:
                    self.stdout.write(
                        f"    DayStartStockCheck({fix_date}): "
                        f"system_carried={sys_now} → {correct_opening}  "
                        f"confirmed={check_fix.confirmed_qty} → {correct_opening}"
                    )
                self.stdout.write(
                    f"    RawStock: {raw_now} → {correct_rawstock}"
                    + (f"  (includes {fix_date_si} today's stock-in)" if fix_date_si else "")
                )

                if not dry_run:
                    with transaction.atomic():
                        if check_fix:
                            check_fix.system_carried_qty = correct_opening
                            check_fix.confirmed_qty = correct_opening
                            check_fix.save(update_fields=[
                                "system_carried_qty", "confirmed_qty"
                            ])
                        RawStock.set_to(outlet, recipe.ingredient, correct_rawstock)
                        ds = DisplayStock.objects.filter(outlet=outlet, product=product).first()
                        if ds:
                            correct_display = int(correct_rawstock / qty_per)
                            ds.pieces_available = correct_display
                            ds.save(update_fields=["pieces_available"])
                            self.stdout.write(f"    DisplayStock → {correct_display}")

                total_fixed += 1

        if total_fixed == 0:
            self.stdout.write("\nNo double-counted stock found.")
        elif dry_run:
            self.stdout.write(f"\n[DRY RUN] {total_fixed} ingredient(s) would be corrected.\n")
        else:
            self.stdout.write(self.style.SUCCESS(f"\nFixed {total_fixed} ingredient(s).\n"))
