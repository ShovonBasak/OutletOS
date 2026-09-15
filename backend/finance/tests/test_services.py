"""Tests for finance.services — the centralized transaction posting/voiding
layer behind AccountTransaction.balance_before/balance_after.

Run with: python manage.py test finance.tests.test_services
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase

from finance.models import AccountTransaction, FinancialAccount
from finance.services import (
    post_transaction, post_transfer_pair, rebuild_account_balances, void_transaction,
)

User = get_user_model()


class FinanceServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="01700000010", password="x")
        self.acct = FinancialAccount.objects.create(
            account_type="CASH", name="Test Cash",
            opening_balance=Decimal("1000"), opening_balance_date=datetime.date(2026, 1, 1),
        )
        self.other = FinancialAccount.objects.create(
            account_type="BANK", name="Test Bank",
            opening_balance=Decimal("500"), opening_balance_date=datetime.date(2026, 1, 1),
        )

    def _post(self, account, amount, date, note=""):
        return post_transaction(
            account=account, transaction_type="ADJUSTMENT", amount=Decimal(amount),
            date=date, entered_by=self.user, note=note,
        )

    def test_sequential_posting(self):
        t1 = self._post(self.acct, "100", datetime.date(2026, 1, 2))
        t2 = self._post(self.acct, "-30", datetime.date(2026, 1, 3))
        t3 = self._post(self.acct, "50", datetime.date(2026, 1, 4))

        self.assertEqual(t1.balance_before, Decimal("1000"))
        self.assertEqual(t1.balance_after, Decimal("1100"))
        self.assertEqual(t2.balance_before, Decimal("1100"))
        self.assertEqual(t2.balance_after, Decimal("1070"))
        self.assertEqual(t3.balance_before, Decimal("1070"))
        self.assertEqual(t3.balance_after, Decimal("1120"))
        self.assertEqual(self.acct.current_balance, Decimal("1120"))

    def test_backdated_insertion_cascades(self):
        t1 = self._post(self.acct, "100", datetime.date(2026, 1, 5))   # day 5
        t3 = self._post(self.acct, "40", datetime.date(2026, 1, 15))   # day 15
        # Now insert a day-10 transaction — should land between t1 and t3.
        t2 = self._post(self.acct, "20", datetime.date(2026, 1, 10))

        t1.refresh_from_db()
        t2.refresh_from_db()
        t3.refresh_from_db()

        self.assertEqual(t1.balance_before, Decimal("1000"))  # untouched
        self.assertEqual(t1.balance_after, Decimal("1100"))   # untouched
        self.assertEqual(t2.balance_before, Decimal("1100"))
        self.assertEqual(t2.balance_after, Decimal("1120"))
        self.assertEqual(t3.balance_before, Decimal("1120"))  # shifted +20
        self.assertEqual(t3.balance_after, Decimal("1160"))   # shifted +20

    def test_same_day_tiebreak_by_id(self):
        t1 = self._post(self.acct, "10", datetime.date(2026, 1, 5))
        t2 = self._post(self.acct, "20", datetime.date(2026, 1, 5))
        self.assertEqual(t2.balance_before, t1.balance_after)

    def test_delete_cascades(self):
        t1 = self._post(self.acct, "100", datetime.date(2026, 1, 2))
        t2 = self._post(self.acct, "30", datetime.date(2026, 1, 3))
        t3 = self._post(self.acct, "50", datetime.date(2026, 1, 4))

        void_transaction(t2.id)

        self.assertFalse(AccountTransaction.objects.filter(pk=t2.id).exists())
        t1.refresh_from_db()
        t3.refresh_from_db()
        self.assertEqual(t1.balance_after, Decimal("1100"))    # untouched
        self.assertEqual(t3.balance_before, Decimal("1100"))   # shifted -30
        self.assertEqual(t3.balance_after, Decimal("1150"))    # shifted -30
        self.assertEqual(self.acct.current_balance, Decimal("1150"))

    def test_opening_balance_change_triggers_rebuild(self):
        t1 = self._post(self.acct, "100", datetime.date(2026, 1, 2))
        t2 = self._post(self.acct, "50", datetime.date(2026, 1, 3))

        self.acct.opening_balance = Decimal("2000")
        self.acct.save(update_fields=["opening_balance"])
        rebuild_account_balances(self.acct.id)

        t1.refresh_from_db()
        t2.refresh_from_db()
        self.assertEqual(t1.balance_before, Decimal("2000"))
        self.assertEqual(t1.balance_after, Decimal("2100"))
        self.assertEqual(t2.balance_before, Decimal("2100"))
        self.assertEqual(t2.balance_after, Decimal("2150"))

    def test_transfer_pair_independent_running_balances(self):
        # Give each account unrelated prior history first.
        self._post(self.acct, "500", datetime.date(2026, 1, 2))     # acct: 1000 -> 1500
        self._post(self.other, "-100", datetime.date(2026, 1, 2))   # other: 500 -> 400

        leg_out, leg_in = post_transfer_pair(
            from_account=self.acct, to_account=self.other, amount=Decimal("200"),
            date=datetime.date(2026, 1, 3), entered_by=self.user,
            source_type="ACCOUNT_TRANSFER", source_id=1,
        )
        self.assertEqual(leg_out.balance_before, Decimal("1500"))
        self.assertEqual(leg_out.balance_after, Decimal("1300"))
        self.assertEqual(leg_in.balance_before, Decimal("400"))
        self.assertEqual(leg_in.balance_after, Decimal("600"))

    def test_transfer_pair_true_atomicity_on_failure(self):
        # A transfer to a nonexistent/invalid account should roll back BOTH
        # legs, not leave leg_out orphaned.
        from django.db import IntegrityError

        bogus = FinancialAccount(id=999999, account_type="BANK", name="ghost",
                                  opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1))
        with self.assertRaises(Exception):
            post_transfer_pair(
                from_account=self.acct, to_account=bogus, amount=Decimal("100"),
                date=datetime.date(2026, 1, 3), entered_by=self.user,
                source_type="ACCOUNT_TRANSFER", source_id=2,
            )
        # No TRANSFER_OUT leg should have survived on self.acct.
        self.assertEqual(self.acct.transactions.count(), 0)
        self.assertEqual(self.acct.current_balance, Decimal("1000"))

    def test_rebuild_idempotent_against_mixed_history(self):
        self._post(self.acct, "100", datetime.date(2026, 1, 5))
        t3 = self._post(self.acct, "40", datetime.date(2026, 1, 15))
        self._post(self.acct, "20", datetime.date(2026, 1, 10))  # backdated
        void_transaction(t3.id)

        before = {
            t.id: (t.balance_before, t.balance_after)
            for t in AccountTransaction.objects.filter(account=self.acct)
        }
        result = rebuild_account_balances(self.acct.id)
        self.assertEqual(result["changed"], 0)

        after = {
            t.id: (t.balance_before, t.balance_after)
            for t in AccountTransaction.objects.filter(account=self.acct)
        }
        self.assertEqual(before, after)
