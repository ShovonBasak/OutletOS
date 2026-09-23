"""Tests for the tenant-application intake/approval flow: TenantApplicationViewSet
(submit/approve/reject) and the Organization.onboarding_completed_at gate.

Run with: python manage.py test catalog.tests.test_tenant_application
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, TenantApplication, TenantApplicationStatus

User = get_user_model()


class SubmitTests(APITestCase):
    def test_submit_requires_no_auth_and_hashes_password(self):
        client = APIClient()  # deliberately unauthenticated
        resp = client.post("/api/tenant-applications/submit/", {
            "org_name": "Golden Bucket", "owner_name": "Rahim Uddin",
            "owner_phone": "01711111111", "owner_password": "correcthorse",
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)

        app = TenantApplication.objects.get(owner_phone="01711111111")
        self.assertEqual(app.status, TenantApplicationStatus.PENDING)
        self.assertNotEqual(app.password_hash, "correcthorse")
        self.assertTrue(check_password("correcthorse", app.password_hash))
        # password_hash must never leak back in the response.
        self.assertNotIn("password_hash", resp.data)
        self.assertNotIn("password", resp.data)

    def test_short_password_rejected(self):
        client = APIClient()
        resp = client.post("/api/tenant-applications/submit/", {
            "org_name": "Golden Bucket", "owner_name": "Rahim Uddin",
            "owner_phone": "01711111112", "owner_password": "short",
        }, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_second_pending_application_same_phone_blocked(self):
        client = APIClient()
        body = {
            "org_name": "Golden Bucket", "owner_name": "Rahim Uddin",
            "owner_phone": "01711111113", "owner_password": "correcthorse",
        }
        first = client.post("/api/tenant-applications/submit/", body, format="json")
        self.assertEqual(first.status_code, 201)
        second = client.post("/api/tenant-applications/submit/", body, format="json")
        self.assertEqual(second.status_code, 400)
        self.assertEqual(
            TenantApplication.objects.filter(owner_phone="01711111113").count(), 1
        )


class ReviewTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(phone="01799999901", password="x", name="Admin")
        self.owner = User.objects.create_user(phone="01799999902", password="x", name="Owner", role="OWNER")
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(user=self.admin)
        self.owner_client = APIClient()
        self.owner_client.force_authenticate(user=self.owner)

        self.app = TenantApplication.objects.create(
            org_name="Golden Bucket", owner_name="Rahim Uddin",
            owner_phone="01711112222",
            password_hash="pbkdf2_sha256$dummy$not-used-directly",
        )

    def test_owner_cannot_list_or_approve(self):
        resp = self.owner_client.get("/api/tenant-applications/")
        self.assertEqual(resp.status_code, 403)
        resp = self.owner_client.post(f"/api/tenant-applications/{self.app.id}/approve/")
        self.assertEqual(resp.status_code, 403)

    def test_approve_creates_org_and_owner_no_outlet(self):
        from django.contrib.auth.hashers import make_password
        self.app.password_hash = make_password("correcthorse")
        self.app.save(update_fields=["password_hash"])

        resp = self.admin_client.post(f"/api/tenant-applications/{self.app.id}/approve/")
        self.assertEqual(resp.status_code, 200, resp.data)

        self.app.refresh_from_db()
        self.assertEqual(self.app.status, TenantApplicationStatus.APPROVED)
        self.assertEqual(self.app.reviewed_by, self.admin)
        self.assertIsNotNone(self.app.reviewed_at)

        org = self.app.created_organization
        self.assertIsNotNone(org)
        self.assertEqual(org.name, "Golden Bucket")
        self.assertEqual(org.outlets.count(), 0)

        owner = User.objects.get(phone="01711112222")
        self.assertEqual(owner.role, "OWNER")
        self.assertEqual(owner.organization_id, org.id)

        # The owner can actually log in with the password they set at submission.
        login = APIClient().post("/api/auth/login/", {
            "phone": "01711112222", "password": "correcthorse",
        }, format="json")
        self.assertEqual(login.status_code, 200, login.data)

    def test_double_approve_rejected(self):
        resp1 = self.admin_client.post(f"/api/tenant-applications/{self.app.id}/approve/")
        self.assertEqual(resp1.status_code, 200)
        resp2 = self.admin_client.post(f"/api/tenant-applications/{self.app.id}/approve/")
        self.assertEqual(resp2.status_code, 400)

    def test_approve_with_colliding_phone_rolls_back_cleanly(self):
        User.objects.create_user(phone="01711112222", password="x", name="Existing", role="STAFF")
        orgs_before = Organization.objects.count()

        resp = self.admin_client.post(f"/api/tenant-applications/{self.app.id}/approve/")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Organization.objects.count(), orgs_before)

        self.app.refresh_from_db()
        self.assertEqual(self.app.status, TenantApplicationStatus.PENDING)

    def test_reject_sets_status_and_reason(self):
        resp = self.admin_client.post(
            f"/api/tenant-applications/{self.app.id}/reject/",
            {"reason": "Duplicate application"}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        self.app.refresh_from_db()
        self.assertEqual(self.app.status, TenantApplicationStatus.REJECTED)
        self.assertEqual(self.app.reviewed_by, self.admin)
        self.assertEqual(self.app.rejection_reason, "Duplicate application")


class OnboardingGateTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-onboarding-gate")
        self.owner = User.objects.create_user(
            phone="01799999903", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.other_org = Organization.objects.create(name="Other Org", slug="other-org-onboarding-gate")
        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.owner)

    def test_complete_onboarding_sets_timestamp(self):
        self.assertIsNone(self.org.onboarding_completed_at)
        resp = self.client_.post(f"/api/organizations/{self.org.id}/complete-onboarding/")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.org.refresh_from_db()
        self.assertIsNotNone(self.org.onboarding_completed_at)

    def test_cannot_complete_onboarding_for_another_org(self):
        resp = self.client_.post(f"/api/organizations/{self.other_org.id}/complete-onboarding/")
        self.assertEqual(resp.status_code, 400)
        self.other_org.refresh_from_db()
        self.assertIsNone(self.other_org.onboarding_completed_at)

    def test_user_serializer_reflects_onboarding_state(self):
        resp = self.client_.get("/api/auth/me/")
        self.assertFalse(resp.data["organization_onboarding_complete"])
        self.client_.post(f"/api/organizations/{self.org.id}/complete-onboarding/")
        resp = self.client_.get("/api/auth/me/")
        self.assertTrue(resp.data["organization_onboarding_complete"])
