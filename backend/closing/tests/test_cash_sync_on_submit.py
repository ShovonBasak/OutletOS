"""Regression test: submit()/lock() must post the LIVE computed_cash to the
ledger, not whatever amount the cash PaymentEntry last held.

Bug: PaymentEntry(primary_cash).amount is only ever written by the Payments
step (POST /daily-closings/{id}/payments/). A SUBMITTED closing stays
editable (see DailyClosingViewSet._guard_editable), so if staff edits
counts/online-sell *after* their last visit to Payments — or never visits it
at all before hitting "Submit" — computed_cash drifts away from the stored
PaymentEntry.amount with nothing to reconcile them before
_record_account_transactions posts that stale amount to the cash account,
silently corrupting its running balance by the gap. Reported symptom: staff
saw a correct "today's cash" figure on screen, but the account balance after
closing didn't match (system cash + today's cash) once locked.

Run with: python manage.py test closing.tests.test_cash_sync_on_submit
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet, Product
from closing.models import DailyClosing, DailyClosingSalesLine, LineSource, PaymentEntry
from finance.models import AccountTransaction, FinancialAccount, SourceType
from sales.models import SalesChannel, SettlementType

User = get_user_model()


class CashSyncOnSubmitTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-cash-sync")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.staff = User.objects.create_user(
            phone="01700000301", password="x", name="Test Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        # finance/migrations/0002+0003 seed a default primary-cash account —
        # demote it so the account this test creates is unambiguously "the"
        # primary cash account the `payments` action resolves to.
        FinancialAccount.objects.filter(is_primary_cash=True).update(is_primary_cash=False)
        self.cash = FinancialAccount.objects.create(
            account_type="CASH", name="Test Cash", is_primary_cash=True,
            opening_balance=Decimal("12000"), opening_balance_date=datetime.date(2026, 1, 1),
            organization=self.org,
        )
        self.channel = SalesChannel.objects.create(
            name="Foodi", settlement_type=SettlementType.COLLECTED_AT_OUTLET, organization=self.org,
        )
        self.product_a = Product.objects.create(
            name="Test Item A", requires_preparation=False, organization=self.org,
        )
        self.product_b = Product.objects.create(
            name="Test Item B", requires_preparation=False, organization=self.org,
        )
        self.closing = DailyClosing.objects.create(
            outlet=self.outlet, closing_date=datetime.date(2026, 1, 15), staff=self.staff,
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.staff)

    def _add_offline_sale(self, product, amount: Decimal):
        # unique_together = (daily_closing, product, channel) — a distinct
        # product per call keeps these as separate, independently-summed rows.
        line = DailyClosingSalesLine(
            daily_closing=self.closing, product=product, channel=self.channel,
            quantity_sold=1, unit_price=amount, source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()

    def test_submit_posts_live_cash_not_stale_payment_entry(self):
        # Staff visits the Payments step early — snapshots cash at 4000.
        self._add_offline_sale(self.product_a, Decimal("4000"))
        resp = self.client.post(
            f"/api/daily-closings/{self.closing.id}/payments/", {"entries": []}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        stale_entry = PaymentEntry.objects.get(daily_closing=self.closing, account=self.cash)
        self.assertEqual(stale_entry.amount, Decimal("4000.00"))

        # Staff then adds another offline sale WITHOUT revisiting Payments —
        # today's true cash is now 4000 + 2000 = 6000, but the stored
        # PaymentEntry still says 4000.
        self._add_offline_sale(self.product_b, Decimal("2000"))
        self.closing.refresh_from_db()
        self.assertEqual(self.closing.computed_cash, Decimal("6000.00"))

        balance_before = self.cash.current_balance
        self.assertEqual(balance_before, Decimal("12000.00"))

        resp = self.client.post(f"/api/daily-closings/{self.closing.id}/submit/")
        self.assertEqual(resp.status_code, 200, resp.data)

        txn = AccountTransaction.objects.get(
            source_type=SourceType.DAILY_CLOSING, source_id=self.closing.id, account=self.cash,
        )
        self.assertEqual(txn.amount, Decimal("6000.00"), "posted the stale 4000 instead of live 6000")

        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("18000.00"))  # 12000 + 6000, not 16000
