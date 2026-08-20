"""
Backdate PackDefinition.effective_from to the earliest approved stock-in date
for each ingredient where the first valid pack starts after the first purchase.

This fixes a data entry issue where pack definitions were created with an
effective_from date later than the actual first purchase, causing COGS to
show ৳0 for early sales.

Usage:
    python manage.py fix_pack_effective_from --dry-run   # preview changes
    python manage.py fix_pack_effective_from             # apply
"""
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import F, Min, Q

from catalog.models import PackDefinition
from stock.models import StockInItem, StockInStatus


class Command(BaseCommand):
    help = "Backdate first valid PackDefinition.effective_from to earliest approved stock-in date"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print what would change without writing to the database",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]

        # For each ingredient, find the earliest approved stock-in date
        earliest_by_ingredient = (
            StockInItem.objects.filter(
                stock_in_record__status=StockInStatus.APPROVED,
                ingredient__isnull=False,
            )
            .values("ingredient_id")
            .annotate(first_purchase=Min("stock_in_record__stock_in_date"))
        )
        earliest_map = {row["ingredient_id"]: row["first_purchase"] for row in earliest_by_ingredient}

        fixes = []

        for ingredient_id, first_purchase in earliest_map.items():
            # First valid pack = earliest effective_from, real cost, non-inverted date range
            first_valid_pack = (
                PackDefinition.objects.filter(
                    ingredient_id=ingredient_id,
                    cost_per_pack__gt=0,
                )
                .filter(Q(effective_to__isnull=True) | Q(effective_to__gt=F("effective_from")))
                .select_related("ingredient")
                .order_by("effective_from")
                .first()
            )

            if first_valid_pack is None:
                continue

            if first_purchase < first_valid_pack.effective_from:
                fixes.append((first_valid_pack, first_purchase))

        if not fixes:
            self.stdout.write(self.style.SUCCESS("No gaps found — all pack definitions are already correct."))
            return

        self.stdout.write(f"{'DRY RUN — ' if dry_run else ''}Found {len(fixes)} pack definition(s) to backdate:\n")

        with transaction.atomic():
            for pack, new_from in fixes:
                self.stdout.write(
                    f"  PackDef #{pack.id:>4}  {pack.ingredient.name}\n"
                    f"             effective_from: {pack.effective_from} → {new_from}\n"
                    f"             cost: ৳{pack.cost_per_pack}/{pack.pieces_per_pack} base units\n"
                )
                if not dry_run:
                    pack.effective_from = new_from
                    pack.save(update_fields=["effective_from"])

            if dry_run:
                transaction.set_rollback(True)
                self.stdout.write(self.style.WARNING("\nDry run — no changes written."))
            else:
                self.stdout.write(self.style.SUCCESS(f"\nUpdated {len(fixes)} pack definition(s)."))
