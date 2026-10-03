"""Delete stray RawStock rows for PERIODIC_COUNT ingredients.

Background: a PERIODIC_COUNT ingredient (bags, sticks, sachets with no fixed
per-product ratio — e.g. bamboo skewer sticks) is tracked via periodic
counts, never via RawStock — see stock.services.consume_for_preparation,
which explicitly skips it, and catalog.models.Ingredient.tracking_mode. Any
RawStock row for one is a leftover from before the ingredient was
reclassified: nothing in the live system reads or writes it, so its value is
frozen and disconnected from reality (e.g. CP Five Star's "Fry Point" outlet
has had "Meat Ball Stick Bamboo" sitting at a fixed 526 and "Mayonnaise
Naples" at 14 indefinitely).

Beyond being stale, these rows cause a real bug on the Prep page: before the
frontend fix (see staff/prep/page.tsx), a product's "how many can I prepare"
cap incorrectly factored in every recipe ingredient's RawStock row,
including PERIODIC_COUNT ones — so on an outlet with NO such stray row
(a fresh outlet, which correctly never gets one), the product was hidden
from the Prep picker entirely. The frontend is now fixed to skip these rows
on its own, but the leftover rows themselves are still meaningless data
worth clearing out everywhere they exist.

Safe to run anywhere, any number of times: idempotent (there's nothing left
to delete on a second run), and deleting a RawStock row has no other model
pointing to it (it's purely a derived/cached running balance — see
stock.models.RawStock's docstring).

Usage:
    python manage.py cleanup_periodic_count_rawstock              # dry run (default) — all outlets
    python manage.py cleanup_periodic_count_rawstock --apply       # actually delete — all outlets
    python manage.py cleanup_periodic_count_rawstock --outlet 1 --apply   # one outlet only
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from catalog.models import Outlet, TrackingMode
from stock.models import RawStock


class Command(BaseCommand):
    help = "Delete RawStock rows for PERIODIC_COUNT ingredients — see module docstring."

    def add_arguments(self, parser):
        parser.add_argument(
            "--outlet", type=int, default=None,
            help="Limit to one outlet id. Default: every outlet.",
        )
        parser.add_argument(
            "--apply", action="store_true",
            help="Commit the deletion. Default is dry-run — prints what would be deleted.",
        )

    def handle(self, *args, **options):
        apply_changes = options["apply"]

        qs = RawStock.objects.filter(
            ingredient__tracking_mode=TrackingMode.PERIODIC_COUNT
        ).select_related("outlet", "ingredient")

        if options["outlet"] is not None:
            try:
                outlet = Outlet.objects.get(pk=options["outlet"])
            except Outlet.DoesNotExist:
                self.stderr.write(f"No outlet with id={options['outlet']}")
                return
            qs = qs.filter(outlet=outlet)

        rows = list(qs.order_by("outlet__name", "ingredient__name"))

        if not rows:
            self.stdout.write("No stray PERIODIC_COUNT RawStock rows found. Nothing to do.")
            return

        self.stdout.write(f"{'Deleting' if apply_changes else 'Would delete'} {len(rows)} row(s):")
        for row in rows:
            self.stdout.write(
                f"  {row.outlet.name} — {row.ingredient.name}: "
                f"{row.quantity_available} {row.ingredient.base_unit}"
            )

        if not apply_changes:
            self.stdout.write("\nDry run — no changes made. Re-run with --apply to delete these rows.")
            return

        with transaction.atomic():
            count, _ = qs.delete()
        self.stdout.write(self.style.SUCCESS(f"\nDeleted {count} row(s)."))
