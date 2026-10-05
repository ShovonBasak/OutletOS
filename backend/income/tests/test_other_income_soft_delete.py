"""Deleting an OtherIncome entry must be a soft delete — the row stays (with
who/when), only is_deleted flips — and the linked AccountTransaction is
voided so it stops affecting balances/P&L. Mirrors
costs.tests.test_expense_soft_delete.

Run with: python manage.py test income.tests.test_other_income_soft_delete
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet
from finance.models import AccountTransaction, AccountType, FinancialAccount
from income.models import OtherIncome, OtherIncomeCategory

User = get_user_model()


class OtherIncomeSoftDeleteTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-income-soft-delete")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01799999931", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.owner)

        self.category = OtherIncomeCategory.objects.create(name="Scrap sale")
        self.account = FinancialAccount.objects.create(
            organization=self.org, outlet=self.outlet, account_type=AccountType.CASH,
            name="Shop Cash", opening_balance=Decimal("1000"), opening_balance_date=timezone.now().date(),
            is_primary_cash=True,
        )
        self.income = OtherIncome.objects.create(
            outlet=self.outlet, date=timezone.now().date(), category=self.category,
            amount=Decimal("250"), received_into_account=self.account, entered_by=self.owner,
        )
        from finance import services
        services.post_transaction(
            account=self.account, transaction_type="OTHER_INCOME",
            amount=self.income.amount, date=self.income.date, entered_by=self.owner,
            source_type="OTHER_INCOME", source_id=self.income.id, note="Scrap sale",
        )

    def test_delete_soft_deletes_the_row(self):
        resp = self.client_.delete(f"/api/other-incomes/{self.income.id}/")
        self.assertEqual(resp.status_code, 204, resp.data)

        self.income.refresh_from_db()
        self.assertTrue(self.income.is_deleted)
        self.assertIsNotNone(self.income.deleted_at)
        self.assertEqual(self.income.deleted_by_id, self.owner.id)

    def test_deleted_entry_disappears_from_list_and_detail(self):
        self.client_.delete(f"/api/other-incomes/{self.income.id}/")

        list_resp = self.client_.get(f"/api/other-incomes/?outlet={self.outlet.id}")
        ids = [e["id"] for e in list_resp.data["results"]]
        self.assertNotIn(self.income.id, ids)

        detail_resp = self.client_.get(f"/api/other-incomes/{self.income.id}/")
        self.assertEqual(detail_resp.status_code, 404)

    def test_delete_voids_the_linked_account_transaction(self):
        self.assertTrue(
            AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=self.income.id).exists()
        )
        self.client_.delete(f"/api/other-incomes/{self.income.id}/")
        self.assertFalse(
            AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=self.income.id).exists()
        )
        self.account.refresh_from_db()
        self.assertEqual(self.account.current_balance, Decimal("1000"))
