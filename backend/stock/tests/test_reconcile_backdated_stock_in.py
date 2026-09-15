"""DB-backed tests for the "late slip" reconciliation path — a stock-in dated
for a day whose Day-Start Stock Check was already confirmed by the time the
slip is approved, and for the invoice-number duplicate guard.

Run with: python manage.py test stock.tests.test_reconcile_backdated_stock_in
"""
import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from catalog.models import Ingredient, Outlet, PackDefinition, TrackingMode
from stock.models import (
    DayStartStockCheck, OperatingDay, RawStock, StockInItem, StockInRecord,
    StockInStatus, UnitCaptured,
)
from stock.services import reconcile_backdated_stock_in

User = get_user_model()


class ReconcileBackdatedStockInTests(TestCase):
    def setUp(self):
        self.outlet = Outlet.objects.create(name="Test Outlet")
        self.user = User.objects.create_user(phone="01700000000", password="x")
        self.ingredient = Ingredient.objects.create(
            name="Test Ingredient", base_unit="piece", tracking_mode=TrackingMode.RECIPE_LINKED,
        )
        self.pack = PackDefinition.objects.create(
            ingredient=self.ingredient, pieces_per_pack=Decimal("10"),
            cost_per_pack=Decimal("100"), effective_from=datetime.date(2026, 1, 1),
        )

        # Day N: confirmed with some baseline, no discrepancy.
        self.day_n = OperatingDay.objects.create(
            outlet=self.outlet, date=datetime.date(2026, 9, 10),
            stock_confirmed_at=timezone.now(),
        )
        DayStartStockCheck.objects.create(
            operating_day=self.day_n, ingredient=self.ingredient,
            system_carried_qty=Decimal("20"), confirmed_qty=Decimal("20"),
        )

        # Day N+1: already confirmed BEFORE the late slip is approved — this is
        # the check that should get corrected.
        self.day_n1 = OperatingDay.objects.create(
            outlet=self.outlet, date=datetime.date(2026, 9, 11),
            stock_confirmed_at=timezone.now(),
        )
        DayStartStockCheck.objects.create(
            operating_day=self.day_n1, ingredient=self.ingredient,
            system_carried_qty=Decimal("20"), confirmed_qty=Decimal("20"),
        )
        RawStock.objects.create(outlet=self.outlet, ingredient=self.ingredient, quantity_available=Decimal("20"))

    def _make_approved_record(self, stock_in_date, packs, invoice_number=""):
        record = StockInRecord.objects.create(
            outlet=self.outlet, stock_in_date=stock_in_date, submitted_by=self.user,
            status=StockInStatus.APPROVED, reviewed_by=self.user, reviewed_at=timezone.now(),
            invoice_number=invoice_number,
        )
        StockInItem.objects.create(
            stock_in_record=record, ingredient=self.ingredient,
            source="MANUAL", unit_captured=UnitCaptured.PACK,
            confirmed_quantity=Decimal(packs), pack_definition=self.pack,
        )
        return record

    def test_late_slip_corrects_next_day_opening(self):
        # Slip dated for day N, but only approved now (after day N+1's check).
        # 3 packs × 10 pieces/pack = 30 base units.
        record = self._make_approved_record(self.day_n.date, packs=3)
        RawStock.adjust(self.outlet, self.ingredient, Decimal("30"))  # what approve() would already have done

        warnings = reconcile_backdated_stock_in(record)
        self.assertEqual(warnings, [])  # no closing linked in this fixture — nothing to flag

        check = DayStartStockCheck.objects.get(operating_day=self.day_n1, ingredient=self.ingredient)
        self.assertEqual(check.system_carried_qty, Decimal("50"))  # 20 + 30
        self.assertEqual(check.confirmed_qty, Decimal("50"))
        self.assertEqual(check.discrepancy_reason, "")

        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("50"))

    def test_idempotent_on_repeated_calls(self):
        record = self._make_approved_record(self.day_n.date, packs=3)
        RawStock.adjust(self.outlet, self.ingredient, Decimal("30"))

        reconcile_backdated_stock_in(record)
        reconcile_backdated_stock_in(record)
        reconcile_backdated_stock_in(record)

        check = DayStartStockCheck.objects.get(operating_day=self.day_n1, ingredient=self.ingredient)
        self.assertEqual(check.confirmed_qty, Decimal("50"))
        raw = RawStock.objects.get(outlet=self.outlet, ingredient=self.ingredient)
        self.assertEqual(raw.quantity_available, Decimal("50"))

    def test_no_op_when_no_later_confirmed_day(self):
        # Slip dated for day N+1 itself (today) — nothing later has been
        # confirmed yet, so this must be a no-op (the ordinary case).
        record = self._make_approved_record(self.day_n1.date, packs=3)
        warnings = reconcile_backdated_stock_in(record)
        self.assertEqual(warnings, [])

        check = DayStartStockCheck.objects.get(operating_day=self.day_n1, ingredient=self.ingredient)
        self.assertEqual(check.confirmed_qty, Decimal("20"))  # untouched

    def test_periodic_count_ingredient_skipped(self):
        periodic = Ingredient.objects.create(
            name="Periodic Ingredient", base_unit="piece", tracking_mode=TrackingMode.PERIODIC_COUNT,
        )
        record = StockInRecord.objects.create(
            outlet=self.outlet, stock_in_date=self.day_n.date, submitted_by=self.user,
            status=StockInStatus.APPROVED, reviewed_by=self.user, reviewed_at=timezone.now(),
        )
        StockInItem.objects.create(
            stock_in_record=record, ingredient=periodic,
            source="MANUAL", unit_captured=UnitCaptured.PIECE, confirmed_quantity=Decimal("5"),
        )
        # No DayStartStockCheck exists for `periodic` at all — must not raise.
        warnings = reconcile_backdated_stock_in(record)
        self.assertEqual(warnings, [])


class DuplicateInvoiceConstraintTests(TestCase):
    def setUp(self):
        self.outlet = Outlet.objects.create(name="Test Outlet")
        self.user = User.objects.create_user(phone="01700000001", password="x")

    def _approved(self, invoice_number, date):
        return StockInRecord.objects.create(
            outlet=self.outlet, stock_in_date=date, submitted_by=self.user,
            status=StockInStatus.APPROVED, reviewed_by=self.user, reviewed_at=timezone.now(),
            invoice_number=invoice_number,
        )

    def test_same_invoice_same_date_rejected(self):
        self._approved("INV-1", datetime.date(2026, 8, 13))
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self._approved("INV-1", datetime.date(2026, 8, 13))

    def test_same_invoice_different_date_allowed(self):
        # Real-world case: CP Bangladesh invoice numbers recur across genuinely
        # different deliveries — must not be blocked.
        self._approved("INV-1", datetime.date(2026, 8, 13))
        self._approved("INV-1", datetime.date(2026, 8, 27))
        self.assertEqual(StockInRecord.objects.filter(invoice_number="INV-1").count(), 2)

    def test_blank_invoice_number_never_blocked(self):
        self._approved("", datetime.date(2026, 8, 13))
        self._approved("", datetime.date(2026, 8, 13))
        self.assertEqual(StockInRecord.objects.filter(invoice_number="").count(), 2)

    def test_non_approved_duplicate_allowed(self):
        self._approved("INV-2", datetime.date(2026, 8, 13))
        # A DRAFT with the same invoice/date is fine — only APPROVED collides.
        StockInRecord.objects.create(
            outlet=self.outlet, stock_in_date=datetime.date(2026, 8, 13),
            submitted_by=self.user, status=StockInStatus.DRAFT, invoice_number="INV-2",
        )
        self.assertEqual(StockInRecord.objects.filter(invoice_number="INV-2").count(), 2)

    def test_invoice_number_normalized_on_save(self):
        record = self._approved("  INV-3  ", datetime.date(2026, 8, 13))
        record.refresh_from_db()
        self.assertEqual(record.invoice_number, "INV-3")
