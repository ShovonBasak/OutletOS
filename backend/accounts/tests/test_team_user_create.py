"""Regression tests for TeamUserViewSet.perform_create's organization
handling. OWNER/STAFF must always belong to exactly one Organization (see
accounts.models.User) — an ADMIN creating a team member who picks an outlet
but omits organization used to leave the user with organization=None,
silently orphaned from every Owner's Team page (invisible there, even
though they could still log in via their assigned outlet).

Run with: python manage.py test accounts.tests.test_team_user_create
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet

User = get_user_model()


class TeamUserCreateOrganizationTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(phone="01799999801", password="x", name="Admin")
        self.org = Organization.objects.create(name="Test Org", slug="test-org-team-create")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.admin)

    def test_admin_create_with_outlet_but_no_organization_derives_it(self):
        resp = self.client_.post("/api/team-users/", {
            "name": "New Staff", "phone": "01788800001", "password": "x12345678",
            "role": "STAFF", "outlet": self.outlet.id,
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["organization"], self.org.id)

        user = User.objects.get(phone="01788800001")
        self.assertEqual(user.organization_id, self.org.id)

    def test_admin_create_staff_with_no_outlet_and_no_organization_rejected(self):
        resp = self.client_.post("/api/team-users/", {
            "name": "Orphan", "phone": "01788800002", "password": "x12345678", "role": "STAFF",
        }, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(User.objects.filter(phone="01788800002").exists())

    def test_admin_create_admin_role_without_organization_is_fine(self):
        resp = self.client_.post("/api/team-users/", {
            "name": "New Admin", "phone": "01788800003", "password": "x12345678", "role": "ADMIN",
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertIsNone(resp.data["organization"])

    def test_admin_create_with_explicit_organization_is_respected(self):
        other_org = Organization.objects.create(name="Other Org", slug="other-org-team-create")
        resp = self.client_.post("/api/team-users/", {
            "name": "Explicit Org Staff", "phone": "01788800004", "password": "x12345678",
            "role": "STAFF", "outlet": self.outlet.id, "organization": other_org.id,
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(resp.data["organization"], other_org.id)

    def test_owner_created_staff_is_visible_on_owner_team_list(self):
        owner = User.objects.create_user(
            phone="01799999802", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        owner_client = APIClient()
        owner_client.force_authenticate(user=owner)

        create = owner_client.post("/api/team-users/", {
            "name": "Owner's Staff", "phone": "01788800005", "password": "x12345678",
            "outlet": self.outlet.id,
        }, format="json")
        self.assertEqual(create.status_code, 201, create.data)

        listing = owner_client.get("/api/team-users/")
        names = [u["name"] for u in listing.data["results"]]
        self.assertIn("Owner's Staff", names)
