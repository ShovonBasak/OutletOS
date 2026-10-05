"""compute_pnl must not count a soft-deleted OtherIncome entry — mirrors
reports.tests.test_pnl_excludes_deleted_expenses, for the income side.

Run with: python manage.py test reports.tests.test_pnl_excludes_deleted_other_income
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from catalog.models import Organization, Outlet
from income.models import OtherIncome, OtherIncomeCategory
from reports.views import compute_pnl

User = get_user_model()


class PnlExcludesDeletedOtherIncomeTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-pnl-deleted-income")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01799999922", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.category = OtherIncomeCategory.objects.create(name="Scrap sale")
        self.today = timezone.now().date()
        self.kept = OtherIncome.objects.create(
            outlet=self.outlet, date=self.today, category=self.category,
            amount=Decimal("300"), entered_by=self.owner,
        )
        self.deleted = OtherIncome.objects.create(
            outlet=self.outlet, date=self.today, category=self.category,
            amount=Decimal("700"), entered_by=self.owner,
            is_deleted=True, deleted_at=timezone.now(), deleted_by=self.owner,
        )

    def test_soft_deleted_entry_does_not_count_toward_other_income(self):
        pnl = compute_pnl(self.today, self.today, outlet=self.outlet.id)
        self.assertEqual(pnl["other_income"], Decimal("300"))
