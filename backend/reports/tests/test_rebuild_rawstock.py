"""Tests for reports.views._do_rebuild (POST /reports/rebuild-rawstock/).

Real incident this guards against: Chicken Ball/Nuggets/Hot Wings all need a
bamboo skewer stick alongside their main ingredient. The stick is
PERIODIC_COUNT — tracked via periodic counts, never via RawStock (see
stock.services.consume_for_preparation, which explicitly skips it). A fresh
outlet correctly has no RawStock row for it at all. But _do_rebuild used to
zero every RawStock row for the outlet (including PERIODIC_COUNT ones) and
then replay historical PreparationLog consumption against *every* recipe
ingredient with no such skip — so running "Rebuild stock" would have driven
any already-existing PERIODIC_COUNT RawStock row deeply negative, and
created a brand-new (equally wrong) one where none existed before. Either
way, the product's "how many can I prepare" cap on the Prep page reads that
row and silently hides the product the moment it's not comfortably positive.

Run with: python manage.py test reports.tests.test_rebuild_rawstock
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Ingredient, Organization, Outlet, Product, Recipe, TrackingMode
from stock.models import PrepSource, PreparationLog, RawStock

User = get_user_model()


class RebuildRawStockSkipsPeriodicCountTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-rebuild-rawstock")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01700000701", password="x", name="Test Owner", role="OWNER", organization=self.org,
        )
        self.staff = User.objects.create_user(
            phone="01700000702", password="x", name="Test Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )

        self.meat = Ingredient.objects.create(
            name="Chicken Ball Mix", base_unit="piece", tracking_mode=TrackingMode.RECIPE_LINKED,
        )
        self.stick = Ingredient.objects.create(
            name="Bamboo Stick", base_unit="piece", tracking_mode=TrackingMode.PERIODIC_COUNT,
        )
        self.product = Product.objects.create(name="Chicken Ball", requires_preparation=True)
        Recipe.objects.create(product=self.product, ingredient=self.meat, quantity_per_unit=1, is_primary=True)
        Recipe.objects.create(product=self.product, ingredient=self.stick, quantity_per_unit=1)

        self.meat_stock = RawStock.objects.create(
            outlet=self.outlet, ingredient=self.meat, quantity_available=Decimal("500"),
        )
        # A legacy row for the PERIODIC_COUNT ingredient, exactly like CP Five
        # Star's real "Fry Point" outlet has today — pre-dating its
        # reclassification to PERIODIC_COUNT, never updated since.
        self.stick_stock = RawStock.objects.create(
            outlet=self.outlet, ingredient=self.stick, quantity_available=Decimal("526"),
        )

        # Historical prep: 50 Chicken Balls made on an earlier day — enough
        # that the old (buggy) replay would have driven the stick deeply
        # negative (526 - 50 = 476, still positive here, but the point is it
        # must not move AT ALL, not just "stay positive").
        PreparationLog.objects.create(
            outlet=self.outlet, product=self.product, source=PrepSource.FRESH,
            op_date=datetime.date(2026, 1, 5), pieces_prepared=50, logged_by=self.staff,
        )

        self.owner_client = APIClient()
        self.owner_client.force_authenticate(user=self.owner)

    def test_periodic_count_raw_stock_untouched_by_rebuild(self):
        resp = self.owner_client.post(
            "/api/reports/rebuild-rawstock/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.data)

        self.stick_stock.refresh_from_db()
        self.assertEqual(self.stick_stock.quantity_available, Decimal("526"), "PERIODIC_COUNT row must not move")

    def test_recipe_linked_raw_stock_still_replays_normally(self):
        """Sanity check: excluding PERIODIC_COUNT from the rebuild must not
        break the normal RECIPE_LINKED replay it was already doing."""
        resp = self.owner_client.post(
            "/api/reports/rebuild-rawstock/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.data)

        self.meat_stock.refresh_from_db()
        # Zeroed, then -50 from the prep replay (no stock-in ever recorded).
        self.assertEqual(self.meat_stock.quantity_available, Decimal("-50"))

    def test_fresh_outlet_with_no_periodic_count_row_does_not_get_one_created(self):
        """The Chicken Paradise scenario exactly: no RawStock row for the
        stick at all going in. Rebuild must not create one."""
        self.stick_stock.delete()

        resp = self.owner_client.post(
            "/api/reports/rebuild-rawstock/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.data)

        self.assertFalse(
            RawStock.objects.filter(outlet=self.outlet, ingredient=self.stick).exists()
        )
