"""Tests for the "Staff view" toggle's backend contract: STAFF, OWNER, and
ADMIN must all be able to reach the gated daily-flow endpoints (Day-Start,
Stock In, Prep, Closing), since Owner/Admin now legitimately use these same
endpoints — under their own identity — to fix staff mistakes. Guards against
ever tightening IsStaffOwnerOrAdmin (or reverting to a stricter class) and
accidentally locking Owner/Admin back out.

Run with: python manage.py test accounts.tests.test_staff_view_permissions
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from accounts.permissions import IsStaffOwnerOrAdmin
from catalog.models import Organization, Outlet

User = get_user_model()


class IsStaffOwnerOrAdminUnitTests(APITestCase):
    """Direct checks on the permission class, independent of any view."""

    def setUp(self):
        self.perm = IsStaffOwnerOrAdmin()

    def _has_permission(self, user):
        request = type("Req", (), {"user": user})()
        return self.perm.has_permission(request, None)

    def test_staff_allowed(self):
        user = User(role="STAFF")
        self.assertTrue(self._has_permission(user))

    def test_owner_allowed(self):
        user = User(role="OWNER")
        self.assertTrue(self._has_permission(user))

    def test_admin_allowed(self):
        user = User(role="ADMIN")
        self.assertTrue(self._has_permission(user))


class StaffFlowEndpointAccessTests(APITestCase):
    """End-to-end: each role's real JWT-authenticated client hitting the
    actual gated-flow endpoints, matching what the "Staff view" toggle relies
    on in production."""

    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.staff = User.objects.create_user(
            phone="01700000101", password="x", name="Test Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        self.owner = User.objects.create_user(
            phone="01700000102", password="x", name="Test Owner", role="OWNER",
            organization=self.org,
        )
        self.admin = User.objects.create_superuser(
            phone="01700000103", password="x", name="Test Admin",
        )

    def _client_as(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_unauthenticated_blocked(self):
        client = APIClient()
        resp = client.get(f"/api/operating-days/?outlet={self.outlet.id}")
        self.assertEqual(resp.status_code, 401)

    def test_all_three_roles_can_list_operating_days(self):
        for user in (self.staff, self.owner, self.admin):
            resp = self._client_as(user).get(f"/api/operating-days/?outlet={self.outlet.id}")
            self.assertEqual(resp.status_code, 200, f"{user.role} blocked: {resp.data}")

    def test_all_three_roles_can_list_stock_in(self):
        for user in (self.staff, self.owner, self.admin):
            resp = self._client_as(user).get(f"/api/stock-in/?outlet={self.outlet.id}")
            self.assertEqual(resp.status_code, 200, f"{user.role} blocked: {resp.data}")

    def test_all_three_roles_can_list_preparation_logs(self):
        for user in (self.staff, self.owner, self.admin):
            resp = self._client_as(user).get(f"/api/preparation-logs/?outlet={self.outlet.id}")
            self.assertEqual(resp.status_code, 200, f"{user.role} blocked: {resp.data}")

    def test_all_three_roles_can_list_daily_closings(self):
        for user in (self.staff, self.owner, self.admin):
            resp = self._client_as(user).get(f"/api/daily-closings/?outlet={self.outlet.id}")
            self.assertEqual(resp.status_code, 200, f"{user.role} blocked: {resp.data}")

    def test_owner_can_create_stock_in_draft(self):
        """The concrete "Staff view" use case: Owner creates a blank
        Stock In draft — same POST the staff "+ New" button makes — and it's
        honestly attributed to the Owner's own account."""
        resp = self._client_as(self.owner).post(
            "/api/stock-in/",
            {"outlet": self.outlet.id, "stock_in_date": "2026-01-15", "items": []},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["submitted_by"], self.owner.id)

    def test_admin_can_create_stock_in_draft(self):
        resp = self._client_as(self.admin).post(
            "/api/stock-in/",
            {"outlet": self.outlet.id, "stock_in_date": "2026-01-15", "items": []},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["submitted_by"], self.admin.id)
