"""Tests for AccountTransactionViewSet — immutability of posted financial
fields, and that create/destroy route through finance.services rather than
touching AccountTransaction directly.

Run with: python manage.py test finance.tests.test_account_transaction_viewset
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization
from finance.models import AccountTransaction, FinancialAccount
from finance.services import post_transaction

User = get_user_model()


class AccountTransactionViewSetTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-account-txn")
        self.admin = User.objects.create_superuser(phone="01700000020", password="x")
        self.acct = FinancialAccount.objects.create(
            account_type="CASH", name="Test Cash", organization=self.org,
            opening_balance=Decimal("1000"), opening_balance_date=datetime.date(2026, 1, 1),
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.admin)

    def test_manual_entry_computes_balances(self):
        resp = self.client.post("/api/account-transactions/", {
            "account": self.acct.id, "transaction_type": "ADJUSTMENT",
            "amount": "150.00", "date": "2026-01-05", "note": "manual test",
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(Decimal(resp.data["balance_before"]), Decimal("1000.00"))
        self.assertEqual(Decimal(resp.data["balance_after"]), Decimal("1150.00"))

    def test_patch_note_allowed(self):
        txn = post_transaction(
            account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("10"),
            date=datetime.date(2026, 1, 5), entered_by=self.admin, note="old note",
        )
        resp = self.client.patch(f"/api/account-transactions/{txn.id}/", {"note": "new note"}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["note"], "new note")

    def test_patch_amount_rejected(self):
        txn = post_transaction(
            account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("10"),
            date=datetime.date(2026, 1, 5), entered_by=self.admin,
        )
        resp = self.client.patch(f"/api/account-transactions/{txn.id}/", {"amount": "20.00"}, format="json")
        self.assertEqual(resp.status_code, 400)
        txn.refresh_from_db()
        self.assertEqual(txn.amount, Decimal("10"))

    def test_patch_date_rejected(self):
        txn = post_transaction(
            account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("10"),
            date=datetime.date(2026, 1, 5), entered_by=self.admin,
        )
        resp = self.client.patch(f"/api/account-transactions/{txn.id}/", {"date": "2026-01-06"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_patch_account_rejected(self):
        other = FinancialAccount.objects.create(
            account_type="BANK", name="Other", organization=self.org,
            opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1),
        )
        txn = post_transaction(
            account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("10"),
            date=datetime.date(2026, 1, 5), entered_by=self.admin,
        )
        resp = self.client.patch(f"/api/account-transactions/{txn.id}/", {"account": other.id}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_patch_same_value_allowed(self):
        txn = post_transaction(
            account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("10"),
            date=datetime.date(2026, 1, 5), entered_by=self.admin,
        )
        # Re-sending the SAME amount is not a real change — should be allowed.
        resp = self.client.patch(f"/api/account-transactions/{txn.id}/", {"amount": "10.00"}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)

    def test_recompute_balances_endpoint(self):
        post_transaction(account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("100"),
                          date=datetime.date(2026, 1, 2), entered_by=self.admin)
        resp = self.client.get(f"/api/financial-accounts/{self.acct.id}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(Decimal(resp.data["current_balance"]), Decimal("1100.00"))

        resp2 = self.client.post(f"/api/financial-accounts/{self.acct.id}/recompute-balances/")
        self.assertEqual(resp2.status_code, 200, resp2.data)
        self.assertEqual(resp2.data["changed"], 0)  # already correct

    def test_destroy_cascades_via_void(self):
        t1 = post_transaction(account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("100"),
                               date=datetime.date(2026, 1, 2), entered_by=self.admin)
        t2 = post_transaction(account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("30"),
                               date=datetime.date(2026, 1, 3), entered_by=self.admin)
        t3 = post_transaction(account=self.acct, transaction_type="ADJUSTMENT", amount=Decimal("50"),
                               date=datetime.date(2026, 1, 4), entered_by=self.admin)

        resp = self.client.delete(f"/api/account-transactions/{t2.id}/")
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(AccountTransaction.objects.filter(pk=t2.id).exists())

        t3.refresh_from_db()
        self.assertEqual(t3.balance_before, Decimal("1100"))  # shifted down by 30
        self.assertEqual(t3.balance_after, Decimal("1150"))
