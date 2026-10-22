"""Channel settlement flow:

- Each day a Direct-to-account channel sells something, its net revenue posts
  into the channel's holding account (AccountType.SALES_CHANNEL) — money the
  platform now owes the outlet, tracked there until it actually pays out.
- expected_amount for a settlement period is computed from actual sales lines
  (not manually typed).
- Receiving a payout transfers OUT of the holding account into wherever it
  actually landed, dated when it arrived — not the sales period.

Run with: python manage.py test closing.tests.test_channel_settlement
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet, Product
from closing.models import (
    ChannelSettlement,
    ClosingStatus,
    DailyClosing,
    DailyClosingSalesLine,
    LineSource,
    SettlementStatus,
)
from finance.models import AccountTransaction, FinancialAccount, SourceType
from sales.models import SalesChannel, SettlementType

User = get_user_model()


class ChannelSettlementTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-settlement")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01700000401", password="x", name="Owner", role="OWNER",
            outlet=self.outlet, organization=self.org,
        )
        self.staff = User.objects.create_user(
            phone="01700000402", password="x", name="Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        self.holding = FinancialAccount.objects.create(
            account_type="SALES_CHANNEL", name="Foodpanda Holding",
            opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1),
            organization=self.org,
        )
        self.bank = FinancialAccount.objects.create(
            account_type="BANK", name="Test Bank",
            opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1),
            organization=self.org,
        )
        self.channel = SalesChannel.objects.create(
            name="Foodpanda", settlement_type=SettlementType.DIRECT_TO_ACCOUNT,
            commission_rate=Decimal("0.20"), holding_account=self.holding, organization=self.org,
        )
        self.product = Product.objects.create(name="Test Burger", requires_preparation=False)
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)

    def _submit_closing(self, day, amount: Decimal):
        """Create a closing with one line for this channel and actually run
        it through submit() so record_account_transactions fires — not just
        stamp status=SUBMITTED, which would skip the posting entirely."""
        closing = DailyClosing.objects.create(outlet=self.outlet, closing_date=day, staff=self.staff)
        line = DailyClosingSalesLine(
            daily_closing=closing, product=self.product, channel=self.channel,
            quantity_sold=1, unit_price=amount, source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()
        self.client.force_authenticate(user=self.staff)
        resp = self.client.post(f"/api/daily-closings/{closing.id}/submit/")
        self.client.force_authenticate(user=self.owner)
        closing.refresh_from_db()
        return closing, resp

    def test_submitting_a_day_posts_net_revenue_into_holding_account(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        # 20% commission deducted: 500 * 0.8 = 400
        self.assertEqual(self.holding.current_balance, Decimal("400.00"))
        self.bank.refresh_from_db()
        self.assertEqual(self.bank.current_balance, Decimal("0"))

    def test_resubmitting_does_not_duplicate_the_holding_leg(self):
        closing, _ = self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        # Owner re-locks (flagged day) — record_account_transactions reruns.
        self.client.post(f"/api/daily-closings/{closing.id}/lock/")
        self.assertEqual(self.holding.current_balance, Decimal("400.00"))

    def test_generate_computes_expected_from_sales_lines(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        self._submit_closing(datetime.date(2026, 2, 2), Decimal("300"))

        resp = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        })
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(Decimal(resp.data["expected_amount"]), Decimal("640.00"))
        self.assertEqual(resp.data["status"], SettlementStatus.PENDING)

    def test_mark_received_transfers_from_holding_to_deposit_account(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        gen = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        }).data
        settlement_id = gen["id"]
        self.assertEqual(self.holding.current_balance, Decimal("400.00"))

        resp = self.client.post(
            f"/api/channel-settlements/{settlement_id}/mark-received/",
            {"received_amount": "400.00", "received_date": "2026-02-10", "deposit_account": self.bank.id},
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["status"], SettlementStatus.RECEIVED)
        self.assertEqual(resp.data["deposit_account_name"], "Test Bank")

        self.assertEqual(self.holding.current_balance, Decimal("0.00"))
        self.bank.refresh_from_db()
        self.assertEqual(self.bank.current_balance, Decimal("400.00"))

        legs = AccountTransaction.objects.filter(
            source_type=SourceType.CHANNEL_SETTLEMENT, source_id=settlement_id,
        )
        self.assertEqual(legs.count(), 2)
        txn = legs.get(account=self.bank)
        self.assertEqual(txn.date, datetime.date(2026, 2, 10))

    def test_partial_receipt_leaves_the_gap_sitting_in_holding(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        gen = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        }).data
        # expected = 400 (500 * 0.8)
        resp = self.client.post(
            f"/api/channel-settlements/{gen['id']}/mark-received/",
            {"received_amount": "350.00", "received_date": "2026-02-10", "deposit_account": self.bank.id},
        )
        self.assertEqual(resp.data["status"], SettlementStatus.PARTIAL)
        self.assertEqual(Decimal(resp.data["variance"]), Decimal("-50.00"))
        # Only 350 moved out — the other 50 stays visible as still owed.
        self.assertEqual(self.holding.current_balance, Decimal("50.00"))
        self.bank.refresh_from_db()
        self.assertEqual(self.bank.current_balance, Decimal("350.00"))

    def test_mark_received_requires_deposit_account(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        gen = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        }).data

        resp = self.client.post(
            f"/api/channel-settlements/{gen['id']}/mark-received/",
            {"received_amount": "400.00", "received_date": "2026-02-10"},
        )
        self.assertEqual(resp.status_code, 400)

    def test_mark_received_requires_holding_account(self):
        self.channel.holding_account = None
        self.channel.save()
        closing = DailyClosing.objects.create(
            outlet=self.outlet, closing_date=datetime.date(2026, 2, 1), staff=self.staff,
            status=ClosingStatus.SUBMITTED,
        )
        line = DailyClosingSalesLine(
            daily_closing=closing, product=self.product, channel=self.channel,
            quantity_sold=1, unit_price=Decimal("500"), source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()
        gen = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        }).data

        resp = self.client.post(
            f"/api/channel-settlements/{gen['id']}/mark-received/",
            {"received_amount": "400.00", "received_date": "2026-02-10", "deposit_account": self.bank.id},
        )
        self.assertEqual(resp.status_code, 400)

    def test_re_marking_received_voids_prior_transfer(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        gen = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        }).data
        settlement_id = gen["id"]

        self.client.post(
            f"/api/channel-settlements/{settlement_id}/mark-received/",
            {"received_amount": "400.00", "received_date": "2026-02-10", "deposit_account": self.bank.id},
        )
        # Correction: actual amount was slightly different.
        self.client.post(
            f"/api/channel-settlements/{settlement_id}/mark-received/",
            {"received_amount": "390.00", "received_date": "2026-02-11", "deposit_account": self.bank.id},
        )

        legs = AccountTransaction.objects.filter(
            source_type=SourceType.CHANNEL_SETTLEMENT, source_id=settlement_id,
        )
        self.assertEqual(legs.count(), 2)
        self.bank.refresh_from_db()
        self.assertEqual(self.bank.current_balance, Decimal("390.00"))
        self.assertEqual(self.holding.current_balance, Decimal("10.00"))

    def test_draft_closing_excluded_from_expected_amount_and_holding_posting(self):
        self._submit_closing(datetime.date(2026, 2, 1), Decimal("500"))
        draft = DailyClosing.objects.create(
            outlet=self.outlet, closing_date=datetime.date(2026, 2, 2), staff=self.staff,
        )
        line = DailyClosingSalesLine(
            daily_closing=draft, product=self.product, channel=self.channel,
            quantity_sold=1, unit_price=Decimal("1000"), source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()

        # DRAFT never goes through submit(), so record_account_transactions
        # never ran for it — holding only reflects the submitted day.
        self.assertEqual(self.holding.current_balance, Decimal("400.00"))

        resp = self.client.post("/api/channel-settlements/generate/", {
            "outlet": self.outlet.id, "channel": self.channel.id,
            "period_start": "2026-02-01", "period_end": "2026-02-07",
        })
        self.assertEqual(Decimal(resp.data["expected_amount"]), Decimal("400.00"))
