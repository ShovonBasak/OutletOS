"""Deleting an Expense must be a soft delete — the row stays (with who/when),
only is_deleted flips — and the linked AccountTransaction is voided so it
stops affecting balances/P&L.

Run with: python manage.py test costs.tests.test_expense_soft_delete
"""
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet
from costs.models import CostCategory, CostType, Expense
from finance.models import AccountTransaction, AccountType, FinancialAccount

User = get_user_model()


class ExpenseSoftDeleteTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-expense-soft-delete")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01799999901", password="x", name="Owner", role="OWNER", organization=self.org,
        )
        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.owner)

        self.category = CostCategory.objects.create(name="Rent", cost_type=CostType.FIXED)
        self.account = FinancialAccount.objects.create(
            organization=self.org, outlet=self.outlet, account_type=AccountType.CASH,
            name="Shop Cash", opening_balance=Decimal("1000"), opening_balance_date=timezone.now().date(),
            is_primary_cash=True,
        )
        self.expense = Expense.objects.create(
            outlet=self.outlet, date=timezone.now().date(), category=self.category,
            amount=Decimal("250"), paid_from_account=self.account, entered_by=self.owner,
        )
        from finance import services
        services.post_transaction(
            account=self.account, transaction_type="EXPENSE_PAYMENT",
            amount=-self.expense.amount, date=self.expense.date, entered_by=self.owner,
            source_type="EXPENSE", source_id=self.expense.id, note="Rent",
        )

    def test_delete_soft_deletes_the_row(self):
        resp = self.client_.delete(f"/api/expenses/{self.expense.id}/")
        self.assertEqual(resp.status_code, 204, resp.data)

        self.expense.refresh_from_db()
        self.assertTrue(self.expense.is_deleted)
        self.assertIsNotNone(self.expense.deleted_at)
        self.assertEqual(self.expense.deleted_by_id, self.owner.id)

    def test_deleted_expense_disappears_from_list_and_detail(self):
        self.client_.delete(f"/api/expenses/{self.expense.id}/")

        list_resp = self.client_.get(f"/api/expenses/?outlet={self.outlet.id}")
        ids = [e["id"] for e in list_resp.data["results"]]
        self.assertNotIn(self.expense.id, ids)

        detail_resp = self.client_.get(f"/api/expenses/{self.expense.id}/")
        self.assertEqual(detail_resp.status_code, 404)

    def test_delete_voids_the_linked_account_transaction(self):
        self.assertTrue(
            AccountTransaction.objects.filter(source_type="EXPENSE", source_id=self.expense.id).exists()
        )
        self.client_.delete(f"/api/expenses/{self.expense.id}/")
        self.assertFalse(
            AccountTransaction.objects.filter(source_type="EXPENSE", source_id=self.expense.id).exists()
        )
        self.account.refresh_from_db()
        self.assertEqual(self.account.current_balance, Decimal("1000"))
