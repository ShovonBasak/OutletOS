"""
Fix Day-Start Stock Check and day-end (closing) stock for an operating day where a
stock-in slip DATED for the previous day was approved AFTER that day's Day-Start
Stock Check had already been confirmed (the "late slip" pattern — physically
delivered/attributed to the previous day, but logged into the system after the
next day's check was already done).

This is an ABSOLUTE recomputation, not an incremental adjustment — every value is
derived fresh from immutable ledger data (approved StockInItem rows, PreparationLog
consumption, DailyClosingSalesLine sales) each run, and every field is SET rather
than adjusted. That makes it safe to re-run any number of times: it always converges
on the same correct numbers regardless of what --apply run(s) happened before,
including a prior buggy version of this command that added deltas instead of
overwriting (which double-counts if run twice — this version can't).

For the target day D (outlet O):
  1. prev_close(ingredient) = prev_day.DayStartStockCheck.confirmed_qty
                             + Σ approved stock-in dated prev_day.date
                             − Σ prev_day's consumption (prep + non-prep sales)
     This becomes D's new day-start baseline — system_carried_qty AND confirmed_qty
     are both SET to prev_close, with no discrepancy_reason/note (there is nothing
     to reconcile: this *is* what the system should have shown).
  2. day_close(ingredient) = prev_close
                            + Σ approved stock-in dated D
                            − Σ D's consumption (prep + non-prep sales)
     RawStock for that ingredient is SET to day_close.
  3. For non-prep products (requires_preparation=False) whose Recipe touches one of
     these ingredients, DailyClosingStockCount.available_pieces is SET to
     prev_close_pieces + same-day-stock-in_pieces (the "total that passed through"
     formula the closing screen uses), remains_pieces is left untouched (it's a
     staff physical count — ground truth), flag/derived-walkin are recomputed, and
     the SYSTEM_DERIVED walk-in sales line is rebuilt if it changes.
     Prep products are untouched — their RawStock/DisplayStock already come from
     this same ledger via real-time PreparationLog, unaffected by the date bug.

Only ingredients with a DayStartStockCheck row on the PREVIOUS day are touched —
PERIODIC_COUNT ingredients (packaging/sachets) use a different mechanism entirely
and are skipped automatically.

Dry-run by default (prints every change). Pass --apply to commit.
"""
import datetime
from collections import defaultdict
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q


class Command(BaseCommand):
    help = "Recompute Day-Start Stock Check + closing stock for a day whose opening was based on a late-dated stock-in slip."

    def add_arguments(self, parser):
        parser.add_argument("--date", required=True, help="Operating day to fix (YYYY-MM-DD).")
        parser.add_argument("--outlet-id", type=int, default=1, help="Outlet id. Default: 1.")
        parser.add_argument("--apply", action="store_true", help="Commit changes. Default is dry-run.")

    def handle(self, *args, **options):
        from catalog.models import Outlet, TrackingMode
        from closing.models import DailyClosingSalesLine, LineSource
        from sales.models import SalesChannel
        from sales.pricing import resolve_price
        from stock.models import (
            DayStartStockCheck, DisplayStock, OperatingDay, PrepSource,
            PreparationLog, RawStock, StockInItem, StockInStatus,
        )

        apply_changes = options["apply"]
        try:
            fix_date = datetime.date.fromisoformat(options["date"])
        except ValueError:
            self.stderr.write(f"Invalid date: {options['date']}")
            return
        prev_date = fix_date - datetime.timedelta(days=1)

        try:
            outlet = Outlet.objects.get(pk=options["outlet_id"])
        except Outlet.DoesNotExist:
            self.stderr.write(f"No outlet with id={options['outlet_id']}")
            return

        op_day = OperatingDay.objects.filter(outlet=outlet, date=fix_date).first()
        prev_op_day = OperatingDay.objects.filter(outlet=outlet, date=prev_date).first()
        if not op_day or not prev_op_day:
            self.stdout.write(f"Missing OperatingDay for {prev_date} or {fix_date}.")
            return
        if not op_day.stock_confirmed_at:
            self.stdout.write(f"OperatingDay {fix_date} has no Day-Start Stock Check confirmed yet.")
            return

        # ------------------------------------------------------------------
        # Scope: only ingredients on a "late slip" — a stock-in dated for the
        # PREVIOUS day but approved during THIS day's window (after this day's
        # check was already confirmed). Everything else on the ledger is left
        # untouched, even other ingredients that happen to share a
        # DayStartStockCheck row on the previous day.
        # ------------------------------------------------------------------
        next_day = (
            OperatingDay.objects.filter(outlet=outlet, date__gt=fix_date)
            .order_by("date").first()
        )
        window_end = (
            next_day.stock_confirmed_at if next_day and next_day.stock_confirmed_at
            else op_day.stock_confirmed_at + datetime.timedelta(days=1)
        )
        late_ingredient_ids = set(
            StockInItem.objects.filter(
                stock_in_record__outlet=outlet,
                stock_in_record__status=StockInStatus.APPROVED,
                stock_in_record__stock_in_date=prev_date,
                stock_in_record__reviewed_at__gte=op_day.stock_confirmed_at,
                stock_in_record__reviewed_at__lt=window_end,
                ingredient__isnull=False,
            ).values_list("ingredient_id", flat=True)
        )
        if not late_ingredient_ids:
            self.stdout.write("No late-dated slips approved during this operating day. Nothing to fix.")
            return

        prev_checks = {
            c.ingredient_id: c
            for c in DayStartStockCheck.objects.filter(
                operating_day=prev_op_day, ingredient_id__in=late_ingredient_ids
            ).select_related("ingredient")
        }
        if not prev_checks:
            self.stdout.write(f"No Day-Start Stock Check found for {prev_date} on the late-slip ingredients.")
            return

        def stock_in_by_ingredient(day):
            totals = defaultdict(lambda: Decimal("0"))
            items = StockInItem.objects.filter(
                stock_in_record__outlet=outlet,
                stock_in_record__stock_in_date=day,
                stock_in_record__status=StockInStatus.APPROVED,
                ingredient_id__in=prev_checks.keys(),
            ).select_related("pack_definition")
            for item in items:
                totals[item.ingredient_id] += item.base_unit_quantity()
            return totals

        def consumption_by_ingredient(day):
            """Mirrors reports.views._do_rebuild's consumption replay for one day:
            prep consumption for prepped products, sales consumption for the rest."""
            totals = defaultdict(lambda: Decimal("0"))
            prepped_pids = set()
            for log in PreparationLog.objects.filter(
                outlet=outlet, source=PrepSource.FRESH
            ).filter(
                Q(op_date=day) | Q(op_date__isnull=True, timestamp__date=day)
            ).prefetch_related("product__recipes__ingredient"):
                prepped_pids.add(log.product_id)
                for r in log.product.recipes.all():
                    if r.ingredient_id in prev_checks:
                        totals[r.ingredient_id] += Decimal(str(log.pieces_prepared)) * r.quantity_per_unit

            sales_today = defaultdict(int)
            for row in DailyClosingSalesLine.objects.filter(
                daily_closing__outlet_id=outlet.id, daily_closing__closing_date=day
            ).values("product_id", "quantity_sold"):
                sales_today[row["product_id"]] += row["quantity_sold"]

            from catalog.models import Product
            for pid, qty in sales_today.items():
                if pid in prepped_pids:
                    continue
                prod = Product.objects.get(pk=pid)
                for r in prod.recipes.all():
                    if r.ingredient_id in prev_checks:
                        totals[r.ingredient_id] += Decimal(str(qty)) * r.quantity_per_unit
            return totals

        prev_stock_in = stock_in_by_ingredient(prev_date)
        prev_consumption = consumption_by_ingredient(prev_date)
        day_stock_in = stock_in_by_ingredient(fix_date)
        day_consumption = consumption_by_ingredient(fix_date)

        self.stdout.write(f"--- Recomputing {fix_date} opening from {prev_date}'s ledger ---\n")

        new_open: dict[int, Decimal] = {}
        new_close: dict[int, Decimal] = {}
        checks_touched = 0

        for iid, prev_check in prev_checks.items():
            if prev_check.ingredient.tracking_mode == TrackingMode.PERIODIC_COUNT:
                continue

            prev_close = prev_check.confirmed_qty + prev_stock_in[iid] - prev_consumption[iid]
            new_open[iid] = prev_close
            day_close = prev_close + day_stock_in[iid] - day_consumption[iid]
            new_close[iid] = day_close

            check = DayStartStockCheck.objects.filter(operating_day=op_day, ingredient_id=iid).first()
            rs = RawStock.objects.filter(outlet=outlet, ingredient_id=iid).first()
            raw_now = rs.quantity_available if rs else Decimal("0")

            name = prev_check.ingredient.name
            old_open = check.confirmed_qty if check else None
            self.stdout.write(
                f"  {name}:\n"
                f"    day-start  {old_open if check else '(no row)'} → {prev_close}"
                f"  [{prev_date}: open {prev_check.confirmed_qty} + stock-in {prev_stock_in[iid]} "
                f"- consumed {prev_consumption[iid]}]\n"
                f"    RawStock   {raw_now} → {day_close}"
                f"  [{fix_date}: open {prev_close} + stock-in {day_stock_in[iid]} - consumed {day_consumption[iid]}]"
            )

            if apply_changes:
                with transaction.atomic():
                    if check:
                        check.system_carried_qty = prev_close
                        check.confirmed_qty = prev_close
                        check.discrepancy_reason = ""
                        check.note = ""
                        check.save(update_fields=[
                            "system_carried_qty", "confirmed_qty", "discrepancy_reason", "note"
                        ])
                    RawStock.set_to(outlet, prev_check.ingredient, day_close)
            checks_touched += 1

        # ------------------------------------------------------------------
        # Day-end closing: non-prep products only.
        # ------------------------------------------------------------------
        self.stdout.write("\n--- Day-end closing recomputation (non-prep products) ---")
        daily_closing = op_day.daily_closing
        closing_fixed = 0

        if not daily_closing:
            self.stdout.write("No DailyClosing linked to this operating day. Skipping.")
        else:
            walk_in = SalesChannel.objects.filter(name__iexact="Walk-in").first()

            for sc in daily_closing.stock_counts.select_related("product").filter(
                product__requires_preparation=False
            ):
                product = sc.product
                recipes = [
                    r for r in product.recipes.select_related("ingredient").all()
                    if r.ingredient_id in new_open
                ]
                if not recipes:
                    continue

                pieces_options = []
                for recipe in recipes:
                    qty_per = recipe.quantity_per_unit or Decimal("1")
                    open_pieces = int(new_open[recipe.ingredient_id] / qty_per)
                    stock_in_pieces = int(day_stock_in[recipe.ingredient_id] / qty_per)
                    pieces_options.append(open_pieces + stock_in_pieces)
                correct_available = min(pieces_options)

                if correct_available == sc.available_pieces:
                    self.stdout.write(f"  {product.name}: available_pieces already correct ({correct_available}).")
                    continue

                old_walkin = sc.available_pieces - sc.wastage_pieces - sc.remains_pieces - sc.app_channel_sold
                new_walkin = correct_available - sc.wastage_pieces - sc.remains_pieces - sc.app_channel_sold

                self.stdout.write(
                    f"  {product.name}: available_pieces {sc.available_pieces} → {correct_available}  "
                    f"(derived_walkin {old_walkin} → {new_walkin})"
                )

                if apply_changes:
                    with transaction.atomic():
                        sc.available_pieces = correct_available
                        sc.flag = new_walkin < 0
                        sc.save(update_fields=["available_pieces", "flag"])

                        if walk_in:
                            old_line = DailyClosingSalesLine.objects.filter(
                                daily_closing=daily_closing, product=product, channel=walk_in,
                                source=LineSource.SYSTEM_DERIVED,
                            ).first()
                            if new_walkin > 0:
                                price, _ = resolve_price(product, walk_in, fix_date)
                                if old_line:
                                    old_line.quantity_sold = new_walkin
                                    old_line.unit_price = price
                                    old_line.gross_amount = price * new_walkin
                                    old_line.net_amount = old_line.gross_amount
                                    old_line.save(update_fields=[
                                        "quantity_sold", "unit_price", "gross_amount", "net_amount"
                                    ])
                                else:
                                    line = DailyClosingSalesLine(
                                        daily_closing=daily_closing, product=product, channel=walk_in,
                                        quantity_sold=new_walkin, unit_price=price,
                                        source=LineSource.SYSTEM_DERIVED,
                                    )
                                    line.recompute()
                                    line.save()
                                self.stdout.write(f"    walk-in line → {new_walkin} pcs")
                            elif old_line:
                                old_line.delete()
                                self.stdout.write("    walk-in line deleted (walkin <= 0)")

                closing_fixed += 1

            if closing_fixed == 0:
                self.stdout.write("  All non-prep closing rows already consistent.")

        self.stdout.write("")
        if not apply_changes:
            self.stdout.write(self.style.WARNING(
                f"[DRY RUN] {checks_touched} ingredient(s) would be recomputed, "
                f"{closing_fixed} closing row(s) would change. Re-run with --apply to commit."
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                f"Applied: {checks_touched} ingredient(s) recomputed, {closing_fixed} closing row(s) fixed."
            ))
