"""Collected-at-outlet channel commission (e.g. Foodi):

- Staff physically collect the FULL gross amount for these channels — the
  platform doesn't withhold commission upfront the way a Direct-to-account
  payout does. So net_amount (what counts toward cash reconciliation) is the
  full gross, not gross-minus-commission.
- The commission owed is instead auto-registered as an Expense (category
  "Sales Commission"), paid from the organization's primary cash account,
  when the closing is submitted/locked.
- Direct-to-account channels (Foodpanda/Pathao) are unaffected — their
  net_amount still deducts commission, since the platform really does
  withhold it before paying out.

Run with: python manage.py test closing.tests.test_commission_expense
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet, Product
from closing.models import DailyClosing, DailyClosingSalesLine, LineSource
from costs.models import CostCategory, CostType, Expense
from finance.models import AccountTransaction, FinancialAccount
from sales.models import SalesChannel, SettlementType

User = get_user_model()


class CommissionExpenseTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-commission")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.owner = User.objects.create_user(
            phone="01700000501", password="x", name="Owner", role="OWNER",
            outlet=self.outlet, organization=self.org,
        )
        self.staff = User.objects.create_user(
            phone="01700000502", password="x", name="Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        self.shop_cash = FinancialAccount.objects.create(
            account_type="CASH", name="Shop Cash", is_primary_cash=True,
            opening_balance=Decimal("1000"), opening_balance_date=datetime.date(2026, 1, 1),
            organization=self.org,
        )
        self.foodi = SalesChannel.objects.create(
            name="Foodi", settlement_type=SettlementType.COLLECTED_AT_OUTLET,
            commission_rate=Decimal("0.18"), organization=self.org,
        )
        CostCategory.objects.get_or_create(name="Sales Commission", defaults={"cost_type": CostType.VARIABLE})
        self.product = Product.objects.create(name="Test Burger", requires_preparation=False)
        self.client = APIClient()

    def _submit_closing(self, day, channel, amount: Decimal):
        closing = DailyClosing.objects.create(outlet=self.outlet, closing_date=day, staff=self.staff)
        line = DailyClosingSalesLine(
            daily_closing=closing, product=self.product, channel=channel,
            quantity_sold=1, unit_price=amount, source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()
        self.client.force_authenticate(user=self.staff)
        resp = self.client.post(f"/api/daily-closings/{closing.id}/submit/")
        self.client.force_authenticate(user=self.owner)
        closing.refresh_from_db()
        return closing, resp

    def test_net_amount_is_full_gross_for_collected_at_outlet(self):
        closing, resp = self._submit_closing(datetime.date(2026, 2, 1), self.foodi, Decimal("500"))
        self.assertEqual(resp.status_code, 200, resp.data)
        line = closing.sales_lines.get()
        self.assertEqual(line.commission_amount, Decimal("90.00"))
        self.assertEqual(line.net_amount, Decimal("500.00"))
        self.assertEqual(closing.total_sale, Decimal("500.00"))

    def test_submit_registers_commission_as_expense_paid_from_shop_cash(self):
        closing, _ = self._submit_closing(datetime.date(2026, 2, 1), self.foodi, Decimal("500"))

        expense = Expense.objects.get(outlet=self.outlet, is_deleted=False)
        self.assertEqual(expense.category.name, "Sales Commission")
        self.assertEqual(expense.amount, Decimal("90.00"))
        self.assertEqual(expense.paid_from_account_id, self.shop_cash.id)
        self.assertIn("Foodi", expense.description)

        self.shop_cash.refresh_from_db()
        self.assertEqual(self.shop_cash.current_balance, Decimal("910.00"))

    def test_resubmitting_does_not_duplicate_the_commission_expense(self):
        closing, _ = self._submit_closing(datetime.date(2026, 2, 1), self.foodi, Decimal("500"))
        self.client.post(f"/api/daily-closings/{closing.id}/lock/")

        self.assertEqual(Expense.objects.filter(outlet=self.outlet, is_deleted=False).count(), 1)
        self.shop_cash.refresh_from_db()
        self.assertEqual(self.shop_cash.current_balance, Decimal("910.00"))

    def test_zero_commission_rate_creates_no_expense(self):
        self.foodi.commission_rate = Decimal("0")
        self.foodi.save(update_fields=["commission_rate"])
        self._submit_closing(datetime.date(2026, 2, 1), self.foodi, Decimal("500"))

        self.assertFalse(Expense.objects.filter(outlet=self.outlet, is_deleted=False).exists())

    def test_direct_to_account_channel_still_deducts_commission_from_net(self):
        holding = FinancialAccount.objects.create(
            account_type="SALES_CHANNEL", name="Foodpanda Holding",
            opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1),
            organization=self.org,
        )
        foodpanda = SalesChannel.objects.create(
            name="Foodpanda", settlement_type=SettlementType.DIRECT_TO_ACCOUNT,
            commission_rate=Decimal("0.20"), holding_account=holding, organization=self.org,
        )
        closing, _ = self._submit_closing(datetime.date(2026, 2, 1), foodpanda, Decimal("500"))
        line = closing.sales_lines.get()
        self.assertEqual(line.net_amount, Decimal("400.00"))  # 500 - 20% commission
        # No commission expense for Direct-to-account — the platform already
        # withheld it before paying out, it's not billed separately.
        self.assertFalse(Expense.objects.filter(outlet=self.outlet, is_deleted=False).exists())
