"""Tests for FinancialAccountViewSet.create_defaults — the onboarding wizard's
"seed the 3 default accounts" step.

Run with: python manage.py test finance.tests.test_create_defaults
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet
from finance.models import FinancialAccount

User = get_user_model()


class CreateDefaultsTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-create-defaults")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01788888801", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.staff = User.objects.create_user(
            phone="01788888802", password="x", name="Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        self.owner_client = APIClient()
        self.owner_client.force_authenticate(user=self.owner)
        self.staff_client = APIClient()
        self.staff_client.force_authenticate(user=self.staff)

    def test_creates_exactly_three_accounts(self):
        resp = self.owner_client.post(
            "/api/financial-accounts/create-defaults/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(len(resp.data), 3)

        accounts = FinancialAccount.objects.filter(organization=self.org)
        self.assertEqual(accounts.count(), 3)
        names = set(accounts.values_list("name", flat=True))
        self.assertEqual(names, {"Owner Cash", "Shop Cash", "Supplier Credit"})

        shop_cash = accounts.get(name="Shop Cash")
        self.assertTrue(shop_cash.is_primary_cash)
        owner_cash = accounts.get(name="Owner Cash")
        self.assertFalse(owner_cash.is_primary_cash)
        supplier_credit = accounts.get(name="Supplier Credit")
        self.assertEqual(supplier_credit.account_type, "SUPPLIER_CREDIT")

    def test_idempotent_on_repeated_calls(self):
        self.owner_client.post(
            "/api/financial-accounts/create-defaults/", {"outlet": self.outlet.id}, format="json"
        )
        resp = self.owner_client.post(
            "/api/financial-accounts/create-defaults/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(FinancialAccount.objects.filter(organization=self.org).count(), 3)

    def test_staff_forbidden(self):
        resp = self.staff_client.post(
            "/api/financial-accounts/create-defaults/", {"outlet": self.outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 403)

    def test_missing_outlet_rejected(self):
        resp = self.owner_client.post("/api/financial-accounts/create-defaults/", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_outlet_from_another_org_rejected(self):
        other_org = Organization.objects.create(name="Other Org", slug="other-org-create-defaults")
        other_outlet = Outlet.objects.create(name="Other Outlet", organization=other_org)
        resp = self.owner_client.post(
            "/api/financial-accounts/create-defaults/", {"outlet": other_outlet.id}, format="json"
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(FinancialAccount.objects.filter(organization=self.org).count(), 0)
