"""compute_pnl must not count a soft-deleted Expense — Expense.is_deleted was
added so "delete" keeps the row for audit instead of erasing it (see
costs.views.ExpenseViewSet.perform_destroy); every direct ORM query against
Expense outside that viewset has to filter it out by hand, and this one
(P&L) is the business-critical one to pin down with a test.

Run with: python manage.py test reports.tests.test_pnl_excludes_deleted_expenses
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from catalog.models import Organization, Outlet
from costs.models import CostCategory, CostType, Expense
from reports.views import compute_pnl

User = get_user_model()


class PnlExcludesDeletedExpensesTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-pnl-deleted-expense")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01799999921", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.category = CostCategory.objects.create(name="Rent", cost_type=CostType.FIXED)
        self.today = timezone.now().date()
        self.kept = Expense.objects.create(
            outlet=self.outlet, date=self.today, category=self.category,
            amount=Decimal("300"), entered_by=self.owner,
        )
        self.deleted = Expense.objects.create(
            outlet=self.outlet, date=self.today, category=self.category,
            amount=Decimal("700"), entered_by=self.owner,
            is_deleted=True, deleted_at=timezone.now(), deleted_by=self.owner,
        )

    def test_soft_deleted_expense_does_not_count_against_net_profit(self):
        pnl = compute_pnl(self.today, self.today, outlet=self.outlet.id)
        self.assertEqual(pnl["fixed_costs"], Decimal("300"))
