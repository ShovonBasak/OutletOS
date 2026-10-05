"""Expense list pagination (10/page) and the /expenses/summary/ aggregate
action — totals must come from the server now that the list no longer
returns every row at once.

Run with: python manage.py test costs.tests.test_expense_list_and_summary
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet
from costs.models import CostCategory, CostType, Expense
from finance.models import AccountType, FinancialAccount

User = get_user_model()


class ExpenseListPaginationAndSummaryTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-expense-summary")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01799999911", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.owner)

        self.rent = CostCategory.objects.create(name="Rent", cost_type=CostType.FIXED)
        self.misc = CostCategory.objects.create(name="Misc", cost_type=CostType.ADHOC)
        self.cash = FinancialAccount.objects.create(
            organization=self.org, outlet=self.outlet, account_type=AccountType.CASH,
            name="Shop Cash", opening_balance=Decimal("0"), opening_balance_date=timezone.now().date(),
            is_primary_cash=True,
        )
        self.bank = FinancialAccount.objects.create(
            organization=self.org, outlet=self.outlet, account_type=AccountType.BANK,
            name="DBBL", opening_balance=Decimal("0"), opening_balance_date=timezone.now().date(),
        )

        today = timezone.now().date()
        # 12 rent/cash expenses of 100 each + 3 misc/bank expenses of 50 each
        for i in range(12):
            Expense.objects.create(
                outlet=self.outlet, date=today, category=self.rent,
                amount=Decimal("100"), paid_from_account=self.cash, entered_by=self.owner,
            )
        for i in range(3):
            Expense.objects.create(
                outlet=self.outlet, date=today, category=self.misc,
                amount=Decimal("50"), paid_from_account=self.bank, entered_by=self.owner,
            )

    def test_list_is_paginated_ten_per_page(self):
        resp = self.client_.get(f"/api/expenses/?outlet={self.outlet.id}")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["count"], 15)
        self.assertEqual(len(resp.data["results"]), 10)
        self.assertIsNotNone(resp.data["next"])

        resp2 = self.client_.get(f"/api/expenses/?outlet={self.outlet.id}&page=2")
        self.assertEqual(len(resp2.data["results"]), 5)
        self.assertIsNone(resp2.data["next"])

    def test_summary_totals_cover_every_matching_row_not_just_one_page(self):
        resp = self.client_.get(f"/api/expenses/summary/?outlet={self.outlet.id}")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(Decimal(str(resp.data["total"])), Decimal("1350"))  # 12*100 + 3*50
        self.assertEqual(resp.data["count"], 15)

        by_account = {r["name"]: Decimal(str(r["amount"])) for r in resp.data["by_account"]}
        self.assertEqual(by_account["Shop Cash"], Decimal("1200"))
        self.assertEqual(by_account["DBBL"], Decimal("150"))

        by_type = {r["cost_type"]: Decimal(str(r["amount"])) for r in resp.data["by_type"]}
        self.assertEqual(by_type["FIXED"], Decimal("1200"))
        self.assertEqual(by_type["ADHOC"], Decimal("150"))

    def test_summary_respects_filters(self):
        resp = self.client_.get(
            f"/api/expenses/summary/?outlet={self.outlet.id}&cost_type=ADHOC"
        )
        self.assertEqual(Decimal(str(resp.data["total"])), Decimal("150"))
        self.assertEqual(resp.data["count"], 3)

    def test_summary_excludes_soft_deleted_rows(self):
        deleted = Expense.objects.filter(category=self.misc).first()
        self.client_.delete(f"/api/expenses/{deleted.id}/")
        resp = self.client_.get(f"/api/expenses/summary/?outlet={self.outlet.id}")
        self.assertEqual(Decimal(str(resp.data["total"])), Decimal("1300"))
        self.assertEqual(resp.data["count"], 14)
