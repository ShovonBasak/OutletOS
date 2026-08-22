"""
Management command to revert an approved stock-in record.

Undoes all three effects of approval:
  1. Subtracts the quantities that were added to RawStock
  2. Reverses any PackDefinition price versions created by this approval
  3. Deletes the AccountTransaction deducted from the payment account

Use --dry-run to preview without committing.

Usage:
    python manage.py revert_stock_in <stock_in_id>
    python manage.py revert_stock_in <stock_in_id> --dry-run
"""

from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from catalog.models import PackDefinition, TrackingMode
from stock.models import RawStock, StockInRecord, StockInStatus


class Command(BaseCommand):
    help = "Revert an approved stock-in record, undoing RawStock, pack pricing, and account changes."

    def add_arguments(self, parser):
        parser.add_argument("stock_in_id", type=int)
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Preview changes without committing.",
        )

    def handle(self, *args, **options):
        stock_in_id = options["stock_in_id"]
        dry_run = options["dry_run"]

        try:
            record = StockInRecord.objects.select_related(
                "outlet", "reviewed_by", "paid_from_account"
            ).get(pk=stock_in_id)
        except StockInRecord.DoesNotExist:
            raise CommandError(f"StockInRecord #{stock_in_id} not found.")

        if record.status != StockInStatus.APPROVED:
            raise CommandError(
                f"StockInRecord #{stock_in_id} has status '{record.status}' — only APPROVED records can be reverted."
            )

        self.stdout.write(
            f"\nStock-in #{record.id}  |  {record.stock_in_date}  |  "
            f"Invoice: {record.invoice_number or '—'}  |  "
            f"Outlet: {record.outlet.name}"
        )
        self.stdout.write(f"Approved by: {record.reviewed_by}  at {record.reviewed_at}\n")

        items = list(record.items.select_related("ingredient", "pack_definition"))

        raw_stock_changes = []
        pack_reversals = []
        tx_deletions = []

        for item in items:
            if not item.ingredient_id:
                continue

            # ── RawStock ──────────────────────────────────────────────────────
            if item.ingredient.tracking_mode == TrackingMode.RECIPE_LINKED:
                qty = item.base_unit_quantity()
                rs = RawStock.objects.filter(
                    outlet=record.outlet, ingredient=item.ingredient
                ).first()
                current = rs.quantity_available if rs else Decimal("0")
                after = current - qty
                raw_stock_changes.append((item.ingredient, qty, current, after))

            # ── PackDefinition reversal ───────────────────────────────────────
            if (
                item.pack_definition_id
                and item.unit_captured == "PACK"
                and item.confirmed_quantity
            ):
                old_pack = item.pack_definition
                # Was this pack closed by this approval?
                if old_pack.effective_to == record.stock_in_date:
                    new_pack = (
                        PackDefinition.objects.filter(
                            ingredient=old_pack.ingredient,
                            effective_from=record.stock_in_date,
                            effective_to__isnull=True,
                        )
                        .order_by("-id")
                        .first()
                    )
                    pack_reversals.append((old_pack, new_pack))

        # ── AccountTransaction ────────────────────────────────────────────────
        try:
            from finance.models import AccountTransaction

            txs = AccountTransaction.objects.filter(
                source_type="STOCK_IN_RECORD",
                source_id=record.id,
                transaction_type="SUPPLIER_ORDER_DEDUCTION",
            )
            tx_deletions = list(txs)
        except Exception:
            pass

        # ── Print plan ───────────────────────────────────────────────────────
        self.stdout.write("Changes that will be made:")
        self.stdout.write("")

        if raw_stock_changes:
            self.stdout.write("  RawStock adjustments:")
            for ing, qty, current, after in raw_stock_changes:
                warn = "  ⚠ WILL GO NEGATIVE" if after < 0 else ""
                self.stdout.write(
                    f"    {ing.name}: {current} → {after} {ing.base_unit}  (−{qty}){warn}"
                )
        else:
            self.stdout.write("  RawStock: no changes (no recipe-linked items)")

        self.stdout.write("")
        if pack_reversals:
            self.stdout.write("  PackDefinition reversals:")
            for old_pack, new_pack in pack_reversals:
                self.stdout.write(
                    f"    {old_pack.ingredient.name}:"
                )
                if new_pack:
                    self.stdout.write(
                        f"      Delete new pack (cost ৳{new_pack.cost_per_pack}, "
                        f"from {new_pack.effective_from})"
                    )
                    self.stdout.write(
                        f"      Restore old pack (cost ৳{old_pack.cost_per_pack}, "
                        f"effective_to → None)"
                    )
                else:
                    self.stdout.write(
                        f"      Old pack found (cost ৳{old_pack.cost_per_pack}) "
                        f"but no new pack to delete — skipping price revert"
                    )
        else:
            self.stdout.write("  PackDefinition: no price versions to reverse")

        self.stdout.write("")
        if tx_deletions:
            self.stdout.write("  AccountTransaction deletions:")
            for tx in tx_deletions:
                self.stdout.write(
                    f"    ৳{abs(tx.amount)} deduction on {tx.date} from "
                    f"'{tx.account}' will be deleted"
                )
        else:
            self.stdout.write("  AccountTransaction: none found")

        self.stdout.write("")
        self.stdout.write(f"  Status: APPROVED → DRAFT")

        if dry_run:
            self.stdout.write("\n[DRY RUN] No changes committed.\n")
            return

        # ── Commit ───────────────────────────────────────────────────────────
        with transaction.atomic():
            for ing, qty, current, after in raw_stock_changes:
                RawStock.adjust(record.outlet, ing, -qty)

            for old_pack, new_pack in pack_reversals:
                if new_pack:
                    new_pack.delete()
                    old_pack.effective_to = None
                    old_pack.save(update_fields=["effective_to"])

            for tx in tx_deletions:
                tx.delete()

            record.status = StockInStatus.DRAFT
            record.reviewed_by = None
            record.reviewed_at = None
            record.save(update_fields=["status", "reviewed_by", "reviewed_at"])

        self.stdout.write(
            self.style.SUCCESS(
                f"\nDone. Stock-in #{record.id} reverted to DRAFT. "
                f"You can now correct and re-submit it.\n"
            )
        )
