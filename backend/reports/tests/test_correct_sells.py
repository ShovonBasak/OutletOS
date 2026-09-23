"""Tests for reports.views.correct_sells's fix_stock / fix_cash toggles.

Real scenario this covers: staff over-recorded a sale (e.g. 10 rice sold
instead of 8), which understates raw stock by 2 AND overstates the day's
cash by 2 units' worth. If the stock side later self-corrects some other way
(e.g. the next morning's Day-Start Stock Check absorbs the discrepancy),
re-running the stock adjustment here would double-count it — so fix_stock
and fix_cash must be independently toggleable.

Run with: python manage.py test reports.tests.test_correct_sells
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from django.utils import timezone

from catalog.models import Ingredient, Outlet, Product, ProductPrice, Recipe, TrackingMode
from closing.models import DailyClosing, DailyClosingSalesLine, LineSource
from finance.models import AccountTransaction, FinancialAccount, SourceType, TransactionType
from stock.models import RawStock
from sales.models import SalesChannel, SettlementType

User = get_user_model()


class CorrectSellsCashStockTests(APITestCase):
    def setUp(self):
        self.outlet = Outlet.objects.create(name="Test Outlet")
        self.staff = User.objects.create_user(
            phone="01700000501", password="x", name="Test Staff", role="STAFF", outlet=self.outlet,
        )
        self.owner = User.objects.create_user(
            phone="01700000502", password="x", name="Test Owner", role="OWNER",
        )

        FinancialAccount.objects.filter(is_primary_cash=True).update(is_primary_cash=False)
        self.cash = FinancialAccount.objects.create(
            account_type="CASH", name="Test Cash", is_primary_cash=True,
            opening_balance=Decimal("10000"), opening_balance_date=datetime.date(2026, 1, 1),
        )

        self.walk_in = SalesChannel.objects.create(
            name="Walk-in", settlement_type=SettlementType.COLLECTED_AT_OUTLET,
        )

        self.ingredient = Ingredient.objects.create(
            name="Raw Rice", base_unit="portion", tracking_mode=TrackingMode.RECIPE_LINKED,
        )
        self.product = Product.objects.create(name="Rice", requires_preparation=False)
        Recipe.objects.create(product=self.product, ingredient=self.ingredient, quantity_per_unit=1)
        ProductPrice.objects.create(
            product=self.product, price=Decimal("50.00"), effective_from=datetime.date(2026, 1, 1),
        )
        RawStock.objects.create(outlet=self.outlet, ingredient=self.ingredient, quantity_available=Decimal("20"))

        self.closing_date = datetime.date(2026, 2, 10)
        self.closing = DailyClosing.objects.create(
            outlet=self.outlet, closing_date=self.closing_date, staff=self.staff,
        )
        # Staff mistakenly recorded 10 sold instead of the real 8.
        line = DailyClosingSalesLine(
            daily_closing=self.closing, product=self.product, channel=self.walk_in,
            quantity_sold=10, unit_price=Decimal("50.00"), source=LineSource.STAFF_ENTRY,
        )
        line.recompute()
        line.save()

        self.staff_client = APIClient()
        self.staff_client.force_authenticate(user=self.staff)
        self.owner_client = APIClient()
        self.owner_client.force_authenticate(user=self.owner)

        # Submit -> auto-locks (no stock_counts -> no flag) and posts the
        # (wrong, inflated) cash total to the ledger, exactly like a normal day.
        resp = self.staff_client.post(f"/api/daily-closings/{self.closing.id}/submit/")
        assert resp.status_code == 200, resp.data
        self.cash.refresh_from_db()
        assert self.cash.current_balance == Decimal("10500.00"), self.cash.current_balance

    def _correct(self, **extra):
        body = {
            "outlet": self.outlet.id, "date": str(self.closing_date),
            "corrections": [{"product_id": self.product.id, "new_qty": 8}],
        }
        body.update(extra)
        return self.owner_client.post("/api/reports/correct-sells/", body, format="json")

    def test_default_fixes_both_stock_and_cash(self):
        resp = self._correct()
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertTrue(resp.data["cash_resynced"])

        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("22"))  # 20 + 2 returned

        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("10400.00"))  # 10000 + 8*50

    def test_fix_cash_only_leaves_stock_untouched(self):
        """The reported scenario: stock already self-corrected (e.g. via this
        morning's Day-Start Stock Check), so only cash should be fixed."""
        resp = self._correct(fix_stock=False, fix_cash=True)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertTrue(resp.data["cash_resynced"])
        self.assertFalse(resp.data["applied"][0]["stock_adjusted"])

        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("20"))  # untouched

        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("10400.00"))  # still corrected

    def test_fix_stock_only_leaves_cash_stale(self):
        resp = self._correct(fix_stock=True, fix_cash=False)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertFalse(resp.data["cash_resynced"])

        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("22"))

        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("10500.00"))  # unchanged, still stale

    def test_both_off_touches_neither(self):
        resp = self._correct(fix_stock=False, fix_cash=False)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertFalse(resp.data["cash_resynced"])

        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("20"))
        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("10500.00"))

        # But the sale itself (and hence future reports) is still corrected.
        self.closing.refresh_from_db()
        line = DailyClosingSalesLine.objects.get(daily_closing=self.closing, product=self.product)
        self.assertEqual(line.quantity_sold, 8)

    def test_cash_fix_posts_separate_dated_adjustment_not_a_rewrite(self):
        """The actual ask: never silently edit the original settled entry —
        post a standalone, today-dated correction instead, so both remain
        visible in the account's history."""
        txns_before = list(
            AccountTransaction.objects.filter(
                source_type=SourceType.DAILY_CLOSING, source_id=self.closing.id, account=self.cash,
            )
        )
        self.assertEqual(len(txns_before), 1)
        original = txns_before[0]
        self.assertEqual(original.transaction_type, TransactionType.SALES_COLLECTION)
        self.assertEqual(original.amount, Decimal("500.00"))
        self.assertEqual(original.date, self.closing_date)

        resp = self._correct()
        self.assertEqual(resp.status_code, 200, resp.data)

        # The original entry is untouched — same id, same amount, same date.
        original.refresh_from_db()
        self.assertEqual(original.amount, Decimal("500.00"))
        self.assertEqual(original.date, self.closing_date)

        # A new, separate ADJUSTMENT entry covers just the delta, dated today.
        txns_after = list(
            AccountTransaction.objects.filter(
                source_type=SourceType.DAILY_CLOSING, source_id=self.closing.id, account=self.cash,
            ).order_by("id")
        )
        self.assertEqual(len(txns_after), 2)
        self.assertEqual(txns_after[0].id, original.id)
        correction = txns_after[1]
        self.assertEqual(correction.transaction_type, TransactionType.ADJUSTMENT)
        self.assertEqual(correction.amount, Decimal("-100.00"))
        self.assertEqual(correction.date, timezone.localdate())
        self.assertIn("Rice", correction.note)

        # Net effect still lands on the correct final balance.
        self.cash.refresh_from_db()
        self.assertEqual(self.cash.current_balance, Decimal("10400.00"))

    def test_day_overview_sales_section_reflects_correction(self):
        """Owner -> Day View's Sales section must not keep showing the
        pre-correction quantity — it used to read DailyClosingStockCount
        fields correct_sells never touches, instead of the sales lines it
        actually edits."""
        before = self.owner_client.get(
            f"/api/reports/day-overview/?outlet={self.outlet.id}&date={self.closing_date}"
        )
        self.assertEqual(before.status_code, 200, before.data)
        row = before.data["closing"]["sales_by_product"][0]
        self.assertEqual(row["product_name"], "Rice")
        self.assertEqual(row["total_sold"], 10)
        self.assertEqual(row["walkin_sold"], 10)
        self.assertEqual(Decimal(row["revenue"]), Decimal("500.00"))

        resp = self._correct()
        self.assertEqual(resp.status_code, 200, resp.data)

        after = self.owner_client.get(
            f"/api/reports/day-overview/?outlet={self.outlet.id}&date={self.closing_date}"
        )
        self.assertEqual(after.status_code, 200, after.data)
        row = after.data["closing"]["sales_by_product"][0]
        self.assertEqual(row["total_sold"], 8)
        self.assertEqual(row["walkin_sold"], 8)
        self.assertEqual(Decimal(row["revenue"]), Decimal("400.00"))
