"""Tests for the "Staff view" toggle's backend contract: STAFF and OWNER
must be able to reach the gated daily-flow endpoints (Day-Start, Stock In,
Prep, Closing), since Owner now legitimately uses these same endpoints —
under their own identity — to fix staff mistakes. ADMIN is read-only here:
it's the cross-org platform-admin role, not a per-tenant operational one, so
it can view any tenant's daily-flow data for support but can't write it.
Guards against ever loosening IsStaffOwnerFullAdminReadOnly back into
ADMIN write access, or tightening it and accidentally locking Owner back out.

Run with: python manage.py test accounts.tests.test_staff_view_permissions
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from accounts.permissions import IsStaffOwnerFullAdminReadOnly
from catalog.models import Organization, Outlet

User = get_user_model()


class IsStaffOwnerFullAdminReadOnlyUnitTests(APITestCase):
    """Direct checks on the permission class, independent of any view."""

    def setUp(self):
        self.perm = IsStaffOwnerFullAdminReadOnly()

    def _has_permission(self, user, method="GET"):
        request = type("Req", (), {"user": user, "method": method})()
        return self.perm.has_permission(request, None)

    def test_staff_allowed_to_write(self):
        user = User(role="STAFF")
        self.assertTrue(self._has_permission(user, "POST"))

    def test_owner_allowed_to_write(self):
        user = User(role="OWNER")
        self.assertTrue(self._has_permission(user, "POST"))

    def test_admin_allowed_to_read(self):
        user = User(role="ADMIN")
        self.assertTrue(self._has_permission(user, "GET"))

    def test_admin_not_allowed_to_write(self):
        user = User(role="ADMIN")
        self.assertFalse(self._has_permission(user, "POST"))


class StaffFlowEndpointAccessTests(APITestCase):
    """End-to-end: each role's real JWT-authenticated client hitting the
    actual gated-flow endpoints, matching what the "Staff view" toggle relies
    on in production, and confirming ADMIN's read-only support access."""

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

    def test_admin_cannot_create_stock_in_draft(self):
        """ADMIN is read-only on tenant daily-flow data — it's platform
        support, not a per-tenant operational role."""
        resp = self._client_as(self.admin).post(
            "/api/stock-in/",
            {"outlet": self.outlet.id, "stock_in_date": "2026-01-15", "items": []},
            format="json",
        )
        self.assertEqual(resp.status_code, 403, resp.data)
