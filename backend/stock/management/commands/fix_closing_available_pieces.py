"""
Fix DailyClosingStockCount.available_pieces for days where a stock-in was approved
on the same day as the closing.

Two cases based on whether the count was taken before or after the delivery:

  Count BEFORE delivery (remains <= day_start_confirmed):
    - available_pieces = day_start_confirmed   (delivery wasn't there yet)
    - sold = day_start - remains
    - RawStock = remains + stock_in            (physical balance after delivery arrived)
    - DisplayStock = RawStock

  Count AFTER delivery (remains > day_start_confirmed):
    - available_pieces = day_start + stock_in  (delivery was present when counted)
    - sold = day_start + stock_in - remains
    - RawStock already correct (remains includes delivery)
    - DisplayStock already correct

Detection heuristic: remains > day_start_confirmed → count was after delivery.

Use --dry-run to preview without committing.
Use --date YYYY-MM-DD to fix a single day (default: all non-locked closings).
Use --include-locked to also fix LOCKED closings.
"""

from decimal import Decimal
from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = "Fix available_pieces / RawStock / DisplayStock for mid-day stock-in scenarios."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--date", help="Fix only this date (YYYY-MM-DD)")
        parser.add_argument(
            "--include-locked",
            action="store_true",
            help="Also fix LOCKED closings (changes finalized accounting history).",
        )

    def handle(self, *args, **options):
        import datetime
        from closing.models import DailyClosing, DailyClosingSalesLine, LineSource
        from stock.models import (
            StockInItem, StockInStatus, OperatingDay, DayStartStockCheck,
            RawStock, DisplayStock,
        )
        from sales.models import SalesChannel
        from sales.pricing import resolve_price

        dry_run = options["dry_run"]
        include_locked = options["include_locked"]
        only_date = options.get("date")

        walk_in = SalesChannel.objects.filter(name__iexact="Walk-in").first()

        qs = DailyClosing.objects.prefetch_related(
            "stock_counts__product__recipes__ingredient",
        ).order_by("closing_date")

        if only_date:
            try:
                qs = qs.filter(closing_date=datetime.date.fromisoformat(only_date))
            except ValueError:
                self.stderr.write(f"Invalid date: {only_date}")
                return

        if not include_locked:
            qs = qs.exclude(status="LOCKED")

        total_fixed = 0

        for closing in qs:
            # Build {ingredient_id: total_base_units} for today's approved stock-ins
            stock_in_items = list(
                StockInItem.objects.filter(
                    stock_in_record__outlet=closing.outlet,
                    stock_in_record__stock_in_date=closing.closing_date,
                    stock_in_record__status=StockInStatus.APPROVED,
                    ingredient__isnull=False,
                ).select_related("ingredient", "pack_definition", "stock_in_record")
            )
            if not stock_in_items:
                continue

            stock_in_by_ingredient: dict[int, Decimal] = {}
            for item in stock_in_items:
                qty = item.base_unit_quantity()
                stock_in_by_ingredient[item.ingredient_id] = (
                    stock_in_by_ingredient.get(item.ingredient_id, Decimal("0")) + qty
                )

            # Build {ingredient_id: confirmed_qty} from the day-start stock check
            day_start_map: dict[int, Decimal] = {}
            operating_day = OperatingDay.objects.filter(
                outlet=closing.outlet, date=closing.closing_date
            ).first()
            if operating_day:
                for check in DayStartStockCheck.objects.filter(operating_day=operating_day):
                    day_start_map[check.ingredient_id] = check.confirmed_qty

            day_had_changes = False

            for sc in closing.stock_counts.all():
                product = sc.product
                if product.requires_preparation:
                    continue

                recipes = list(product.recipes.select_related("ingredient").all())
                if not recipes:
                    continue

                # Collect per-ingredient data for ingredients that had stock-in today
                recipe_data = []
                for recipe in recipes:
                    iid = recipe.ingredient_id
                    ing_stock_in = stock_in_by_ingredient.get(iid, Decimal("0"))
                    if ing_stock_in <= 0:
                        continue
                    ing_day_start = day_start_map.get(iid, Decimal("0"))
                    qty_per = recipe.quantity_per_unit or Decimal("1")
                    pieces_day_start = int(ing_day_start / qty_per)
                    pieces_stock_in = int(ing_stock_in / qty_per)
                    recipe_data.append((recipe, iid, ing_stock_in, qty_per, pieces_day_start, pieces_stock_in))

                if not recipe_data:
                    continue

                # For single-ingredient products (typical for non-prep), use its values.
                # For multi-ingredient, take the minimum over all relevant ingredients.
                pieces_day_start = min(rd[4] for rd in recipe_data)
                pieces_stock_in_total = min(rd[5] for rd in recipe_data)

                # Heuristic: if remains > day_start, count was taken AFTER delivery arrived.
                count_was_after_delivery = sc.remains_pieces > pieces_day_start

                # In both cases available = day_start + stock_in (total that passed through).
                correct_available = pieces_day_start + pieces_stock_in_total

                # For "count before delivery": remains doesn't yet include the delivery,
                # so correct it to the true end-of-day balance.
                if count_was_after_delivery:
                    correct_remains = sc.remains_pieces  # delivery already in staff count
                else:
                    correct_remains = sc.remains_pieces + pieces_stock_in_total

                old_walkin = sc.available_pieces - sc.wastage_pieces - sc.remains_pieces - sc.app_channel_sold
                new_walkin = correct_available - sc.wastage_pieces - correct_remains - sc.app_channel_sold

                nothing_changed = (
                    sc.available_pieces == correct_available
                    and sc.remains_pieces == correct_remains
                )
                if nothing_changed:
                    continue

                self.stdout.write(
                    f"\n  {closing.closing_date} [{closing.status}]  {product.name}"
                    f"  ({'after' if count_was_after_delivery else 'before'} delivery)"
                )
                if sc.available_pieces != correct_available:
                    self.stdout.write(
                        f"    available_pieces: {sc.available_pieces} → {correct_available}"
                        f"  (day_start={pieces_day_start}, stock_in={pieces_stock_in_total})"
                    )
                if sc.remains_pieces != correct_remains:
                    self.stdout.write(
                        f"    remains_pieces:   {sc.remains_pieces} → {correct_remains}"
                    )
                self.stdout.write(
                    f"    derived_walkin:   {old_walkin} → {new_walkin}"
                )

                # RawStock = correct_remains in base units (true end-of-day physical balance).
                for recipe, iid, ing_stock_in, qty_per, _, _ in recipe_data:
                    correct_raw = Decimal(correct_remains) * qty_per
                    rs_now = RawStock.objects.filter(
                        outlet=closing.outlet, ingredient=recipe.ingredient
                    ).first()
                    raw_now = rs_now.quantity_available if rs_now else Decimal("0")
                    if raw_now != correct_raw:
                        self.stdout.write(
                            f"    RawStock({recipe.ingredient.name}): {raw_now} → {correct_raw}"
                        )

                if not dry_run:
                    with transaction.atomic():
                        sc.available_pieces = correct_available
                        sc.remains_pieces = correct_remains
                        sc.flag = new_walkin < 0
                        sc.save(update_fields=["available_pieces", "remains_pieces", "flag"])

                        for recipe, iid, ing_stock_in, qty_per, _, _ in recipe_data:
                            correct_raw = Decimal(correct_remains) * qty_per
                            RawStock.set_to(closing.outlet, recipe.ingredient, correct_raw)
                            ds = DisplayStock.objects.filter(
                                outlet=closing.outlet, product=product
                            ).first()
                            if ds:
                                ds.pieces_available = int(correct_raw / qty_per)
                                ds.save(update_fields=["pieces_available"])

                        # Rebuild SYSTEM_DERIVED walk-in sales line.
                        if walk_in:
                            old_line = DailyClosingSalesLine.objects.filter(
                                daily_closing=closing,
                                product=product,
                                channel=walk_in,
                                source=LineSource.SYSTEM_DERIVED,
                            ).first()
                            if new_walkin > 0:
                                price, _ = resolve_price(product, walk_in, closing.closing_date)
                                if old_line:
                                    old_line.quantity_sold = new_walkin
                                    old_line.unit_price = price
                                    old_line.gross_amount = price * new_walkin
                                    old_line.net_amount = old_line.gross_amount
                                    old_line.save(update_fields=[
                                        "quantity_sold", "unit_price", "gross_amount", "net_amount"
                                    ])
                                    self.stdout.write(f"    walk-in line updated: → {new_walkin} pcs")
                                else:
                                    line = DailyClosingSalesLine(
                                        daily_closing=closing,
                                        product=product,
                                        channel=walk_in,
                                        quantity_sold=new_walkin,
                                        unit_price=price,
                                        source=LineSource.SYSTEM_DERIVED,
                                    )
                                    line.recompute()
                                    line.save()
                                    self.stdout.write(f"    walk-in line created: {new_walkin} pcs")
                            elif old_line:
                                old_line.delete()
                                self.stdout.write("    walk-in line deleted (walkin ≤ 0)")

                day_had_changes = True
                total_fixed += 1

            if not day_had_changes:
                pass

        if total_fixed == 0:
            self.stdout.write("\nNo affected stock counts found.")
        elif dry_run:
            self.stdout.write(f"\n[DRY RUN] {total_fixed} stock count(s) would be updated.\n")
        else:
            self.stdout.write(
                self.style.SUCCESS(f"\nFixed {total_fixed} stock count(s).\n")
            )
