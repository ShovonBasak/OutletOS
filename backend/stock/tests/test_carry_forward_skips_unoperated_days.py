"""Regression test: carry_forward_candidates() must skip over a day that was
force-closed without ever operating (no linked DailyClosing) and reach back to
the last day that actually has closing stock counts.

Reproduces a real incident: Sept 27 closed with prep leftovers, Sept 28 was
never opened and got force-closed via "Skip this day" (status=CLOSED,
daily_closing=None), and Sept 29's carry-forward list came up empty because
previous_operating_day() found Sept 28 — the nearest OperatingDay row — and
gave up there instead of looking further back to Sept 27.

Run with: python manage.py test stock.tests.test_carry_forward_skips_unoperated_days
"""
from datetime import date

from django.contrib.auth import get_user_model
from django.test import TestCase

from catalog.models import Outlet, Product
from closing.models import ClosingStatus, DailyClosing, DailyClosingStockCount
from stock.models import OperatingDay, OperatingDayStatus
from stock.services import carry_forward_candidates

User = get_user_model()


class CarryForwardSkipsUnoperatedDaysTests(TestCase):
    def setUp(self):
        self.outlet = Outlet.objects.create(name="Test Outlet")
        self.staff = User.objects.create_user(
            phone="01700000301", password="x", name="Test Staff", role="STAFF", outlet=self.outlet,
        )
        self.product = Product.objects.create(name="Hot & Crispy Chicken", requires_preparation=True)

    def _closed_day(self, on_date, remains_pieces):
        closing = DailyClosing.objects.create(
            outlet=self.outlet, closing_date=on_date, staff=self.staff, status=ClosingStatus.LOCKED,
        )
        DailyClosingStockCount.objects.create(
            daily_closing=closing, product=self.product,
            available_pieces=remains_pieces + 5, remains_pieces=remains_pieces,
        )
        OperatingDay.objects.create(
            outlet=self.outlet, date=on_date, status=OperatingDayStatus.CLOSED, daily_closing=closing,
        )
        return closing

    def test_skips_force_closed_day_with_no_closing(self):
        self._closed_day(date(2026, 9, 27), remains_pieces=8)

        # Sept 28 never operated — force-closed via "Skip this day": status
        # CLOSED but daily_closing stays None, exactly like force_close() leaves it.
        OperatingDay.objects.create(
            outlet=self.outlet, date=date(2026, 9, 28), status=OperatingDayStatus.CLOSED, daily_closing=None,
        )

        today = OperatingDay.objects.create(
            outlet=self.outlet, date=date(2026, 9, 29), status=OperatingDayStatus.IN_PROGRESS,
        )

        candidates = carry_forward_candidates(today)

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].product_id, self.product.id)
        self.assertEqual(candidates[0].remains_pieces, 8)

    def test_returns_empty_when_no_prior_closing_exists_at_all(self):
        OperatingDay.objects.create(
            outlet=self.outlet, date=date(2026, 9, 28), status=OperatingDayStatus.CLOSED, daily_closing=None,
        )
        today = OperatingDay.objects.create(
            outlet=self.outlet, date=date(2026, 9, 29), status=OperatingDayStatus.IN_PROGRESS,
        )

        self.assertEqual(carry_forward_candidates(today), [])
