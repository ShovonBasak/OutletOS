"""Regression test for StockInRecordViewSet.approve: a missing `transaction`
import in _lock_and_transition_to_approved (split out of approve() without
carrying its local `from django.db import ... transaction` import along) made
every single approval 500 with NameError. No existing test exercised the
approve action end-to-end, so it went undetected.

Run with: python manage.py test stock.tests.test_approve_stock_in
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Ingredient, Outlet, TrackingMode
from stock.models import RawStock, StockInStatus

User = get_user_model()


class ApproveStockInTests(APITestCase):
    def setUp(self):
        self.outlet = Outlet.objects.create(name="Test Outlet")
        self.staff = User.objects.create_user(
            phone="01700000201", password="x", name="Test Staff", role="STAFF", outlet=self.outlet,
        )
        self.owner = User.objects.create_user(
            phone="01700000202", password="x", name="Test Owner", role="OWNER",
        )
        self.ingredient = Ingredient.objects.create(
            name="Test Ingredient", base_unit="piece", tracking_mode=TrackingMode.RECIPE_LINKED,
        )

    def _client_as(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_approve_increments_raw_stock(self):
        staff_client = self._client_as(self.staff)
        owner_client = self._client_as(self.owner)

        create_resp = staff_client.post(
            "/api/stock-in/",
            {"outlet": self.outlet.id, "stock_in_date": "2026-01-15", "items": []},
            format="json",
        )
        self.assertEqual(create_resp.status_code, 201, create_resp.data)
        record_id = create_resp.data["id"]

        patch_resp = staff_client.patch(
            f"/api/stock-in/{record_id}/",
            {"items": [{
                "ingredient": self.ingredient.id, "source": "MANUAL",
                "unit_captured": "PIECE", "confirmed_quantity": "10",
            }]},
            format="json",
        )
        self.assertEqual(patch_resp.status_code, 200, patch_resp.data)

        submit_resp = staff_client.post(f"/api/stock-in/{record_id}/submit/")
        self.assertEqual(submit_resp.status_code, 200, submit_resp.data)

        approve_resp = owner_client.post(f"/api/stock-in/{record_id}/approve/")
        self.assertEqual(approve_resp.status_code, 200, approve_resp.data)
        self.assertEqual(approve_resp.data["status"], StockInStatus.APPROVED)

        raw_stock = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw_stock.quantity_available, Decimal("10"))
