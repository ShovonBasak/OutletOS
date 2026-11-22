"""
Correct a single StockInItem's quantity after the fact — e.g. an OCR/data-entry
slip-extraction mistake caught after the record was already approved (seen for
Tandoori Burger: slip said 10, only 2 was confirmed and approved).

`confirmed_quantity` is set to the corrected value. `extracted_quantity` is left
untouched (it's the raw OCR audit trail, not the corrected truth). Every money
field that scales with quantity (total_amount, vat_amount, sd_amount, discount,
line_total) is rescaled by the same ratio — unit_price/rate/vat_rate/sd_rate stay
per-unit and are untouched, so the derived cost-per-pack is unaffected.

If the record is APPROVED, also cascades the correction the same way
StockInRecordViewSet.approve() would have, scoped to just this line's ingredient:
  - RawStock.adjust() by the delta in base units (skipped for ONE_TIME /
    PERIODIC_COUNT ingredients, same as approve())
  - _initialize_direct_stock() to refresh DisplayStock for non-prep products
  - today's open (non-LOCKED) DailyClosingStockCount for any non-prep product
    whose recipe uses this ingredient, same delta-preserving update approve() does
  - the record's slip_subtotal/slip_vat_total/slip_grand_total, by the same deltas
  - an additional SUPPLIER_ORDER_DEDUCTION transaction for the payment-amount
    delta, if the record has paid_from_account set (never edits the original
    transaction directly — that would desync its balance_before/after snapshot
    and every later transaction's on that account)

Dry-run by default (prints the full plan). Pass --apply to commit.

Usage:
    python manage.py fix_stock_in_item_quantity --item-id 2832 --quantity 10
    python manage.py fix_stock_in_item_quantity --item-id 2832 --quantity 10 --apply
"""
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


class Command(BaseCommand):
    help = "Correct a StockInItem's quantity (and proportionally its money fields), cascading to RawStock/DisplayStock/closing/payment if already approved."

    def add_arguments(self, parser):
        parser.add_argument("--item-id", type=int, required=True, help="StockInItem id to correct.")
        parser.add_argument("--quantity", required=True, help="Corrected confirmed_quantity (same unit as unit_captured).")
        parser.add_argument("--apply", action="store_true", help="Commit changes. Default is dry-run.")

    def handle(self, *args, **options):
        from catalog.models import TrackingMode
        from stock.models import RawStock, StockInStatus, UnitCaptured
        from stock.views import _initialize_direct_stock

        apply_changes = options["apply"]

        try:
            new_qty = Decimal(options["quantity"])
        except InvalidOperation:
            raise CommandError(f"Invalid --quantity: {options['quantity']!r}")
        if new_qty <= 0:
            raise CommandError("--quantity must be positive.")

        from stock.models import StockInItem
        try:
            item = StockInItem.objects.select_related(
                "ingredient", "pack_definition", "stock_in_record__outlet",
                "stock_in_record__paid_from_account", "stock_in_record__reviewed_by",
                "stock_in_record__submitted_by",
            ).get(pk=options["item_id"])
        except StockInItem.DoesNotExist:
            raise CommandError(f"StockInItem #{options['item_id']} not found.")

        record = item.stock_in_record
        old_qty = item.confirmed_quantity

        if not item.ingredient_id:
            raise CommandError(
                "This line has no resolved ingredient — resolve it in the UI first, "
                "then correct the quantity."
            )
        if old_qty == new_qty:
            self.stdout.write("Confirmed quantity already matches — nothing to do.")
            return
        if old_qty == 0:
            raise CommandError(
                "Current confirmed_quantity is 0 — can't proportionally rescale money "
                "fields from zero. Edit this line's amounts manually instead."
            )

        ratio = new_qty / old_qty
        label = item.ingredient.name if item.ingredient_id else item.raw_extracted_text

        self.stdout.write(
            f"\nStock-in #{record.id}  |  {record.stock_in_date}  |  status: {record.status}  |  "
            f"outlet: {record.outlet.name}"
        )
        self.stdout.write(f"Item #{item.id}: {label}  ({item.unit_captured})\n")

        # ── Money fields: rescale by the quantity ratio ────────────────────────
        money_fields = ["total_amount", "vat_amount", "sd_amount", "discount", "line_total"]
        old_money = {f: getattr(item, f) for f in money_fields}
        new_money = {
            f: (v * ratio).quantize(Decimal("0.01")) if v is not None else None
            for f, v in old_money.items()
        }

        self.stdout.write(f"  confirmed_quantity: {old_qty} → {new_qty}")
        for f in money_fields:
            if old_money[f] is not None:
                self.stdout.write(f"  {f}: {old_money[f]} → {new_money[f]}")

        delta_line_total = None
        if old_money["line_total"] is not None:
            delta_line_total = new_money["line_total"] - old_money["line_total"]

        # ── Base-unit delta for RawStock (only meaningful once approved) ───────
        pieces_per_pack = (
            item.pack_definition.pieces_per_pack
            if item.unit_captured == UnitCaptured.PACK and item.pack_definition_id
            else Decimal("1")
        )
        delta_base_units = (new_qty - old_qty) * pieces_per_pack

        is_approved = record.status == StockInStatus.APPROVED
        skip_raw_stock = item.ingredient.tracking_mode in (
            TrackingMode.ONE_TIME, TrackingMode.PERIODIC_COUNT
        )

        if is_approved and not skip_raw_stock:
            rs = RawStock.objects.filter(outlet=record.outlet, ingredient=item.ingredient).first()
            current = rs.quantity_available if rs else Decimal("0")
            self.stdout.write(
                f"\n  RawStock ({item.ingredient.name}): {current} → {current + delta_base_units} "
                f"{item.ingredient.base_unit}  (Δ{'+' if delta_base_units >= 0 else ''}{delta_base_units})"
            )
        elif is_approved:
            self.stdout.write(
                f"\n  RawStock: skipped ({item.ingredient.tracking_mode} ingredients aren't tracked via RawStock)"
            )

        # ── Slip totals on the record ───────────────────────────────────────
        slip_deltas = {}
        if is_approved:
            delta_subtotal = (new_money["total_amount"] or Decimal("0")) - (old_money["total_amount"] or Decimal("0"))
            delta_vat = (new_money["vat_amount"] or Decimal("0")) - (old_money["vat_amount"] or Decimal("0"))
            if record.slip_subtotal is not None:
                slip_deltas["slip_subtotal"] = delta_subtotal
            if record.slip_vat_total is not None:
                slip_deltas["slip_vat_total"] = delta_vat
            if record.slip_grand_total is not None and delta_line_total is not None:
                slip_deltas["slip_grand_total"] = delta_line_total

            if slip_deltas:
                self.stdout.write("\n  Slip totals:")
                for f, d in slip_deltas.items():
                    old_v = getattr(record, f)
                    self.stdout.write(f"    {f}: {old_v} → {old_v + d}")

        # ── Payment account ──────────────────────────────────────────────────
        post_payment_delta = None
        if is_approved and record.paid_from_account_id:
            if delta_line_total:
                post_payment_delta = delta_line_total
                self.stdout.write(
                    f"\n  Payment account '{record.paid_from_account}': additional "
                    f"SUPPLIER_ORDER_DEDUCTION of ৳{post_payment_delta} "
                    f"(correcting the delivery cost that was already deducted)"
                )
            else:
                self.stdout.write(
                    "\n  Payment account: no line_total on this item — can't determine "
                    "the deduction delta, skipping. Check manually."
                )

        # ── Closing cascade (direct-stock products touching this ingredient) ──
        closing_plan = []
        if is_approved and not skip_raw_stock:
            from catalog.models import Product
            from closing.models import DailyClosing
            open_closing = (
                DailyClosing.objects
                .filter(outlet=record.outlet, closing_date=record.stock_in_date)
                .exclude(status="LOCKED")
                .first()
            )
            if open_closing:
                affected_products = Product.objects.filter(
                    requires_preparation=False, recipes__ingredient_id=item.ingredient_id
                ).distinct()
                for product in affected_products:
                    sc = open_closing.stock_counts.filter(product=product).first()
                    if sc:
                        closing_plan.append((open_closing, sc, product))

            if closing_plan:
                self.stdout.write(f"\n  Closing #{open_closing.id} ({open_closing.status}) cascade:")
                for _, sc, product in closing_plan:
                    self.stdout.write(
                        f"    {product.name}: will be refreshed from DisplayStock "
                        f"after RawStock correction (currently available={sc.available_pieces}, "
                        f"remains={sc.remains_pieces})"
                    )

        if not apply_changes:
            self.stdout.write(self.style.WARNING("\n[DRY RUN] No changes committed. Re-run with --apply to commit."))
            return

        # ── Commit ───────────────────────────────────────────────────────────
        with transaction.atomic():
            item.confirmed_quantity = new_qty
            for f, v in new_money.items():
                setattr(item, f, v)
            item.save(update_fields=["confirmed_quantity", *money_fields])

            if is_approved and not skip_raw_stock:
                RawStock.adjust(record.outlet, item.ingredient, delta_base_units)
                _initialize_direct_stock(record.outlet)

                for closing, sc, product in closing_plan:
                    from stock.models import DisplayStock
                    ds = DisplayStock.objects.filter(outlet=record.outlet, product=product).first()
                    if not ds:
                        continue
                    new_pieces = ds.pieces_available - sc.remains_pieces
                    if new_pieces > 0:
                        sc.available_pieces += new_pieces
                        sc.remains_pieces = ds.pieces_available
                        sc.save(update_fields=["available_pieces", "remains_pieces"])

                if closing_plan:
                    from closing.services import recompute_closing
                    recompute_closing(closing_plan[0][0])

            if slip_deltas:
                for f, d in slip_deltas.items():
                    setattr(record, f, getattr(record, f) + d)
                record.save(update_fields=list(slip_deltas.keys()))

            if post_payment_delta:
                from finance import services as finance_services
                entered_by = record.reviewed_by or record.submitted_by
                finance_services.post_transaction(
                    account=record.paid_from_account,
                    transaction_type="SUPPLIER_ORDER_DEDUCTION",
                    amount=-post_payment_delta,
                    date=record.stock_in_date,
                    entered_by=entered_by,
                    source_type="STOCK_IN_RECORD",
                    source_id=record.id,
                    note=(
                        f"Quantity correction for {label}: {old_qty} → {new_qty} "
                        f"(stock-in #{record.id})"
                    ),
                )

        self.stdout.write(self.style.SUCCESS(f"\nDone. Item #{item.id} corrected to {new_qty}.\n"))
