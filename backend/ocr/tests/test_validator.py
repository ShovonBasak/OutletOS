"""Unit tests for ocr.validator — InvoiceValidator."""
import unittest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from django.conf import settings
if not settings.configured:
    settings.configure(INSTALLED_APPS=[], DATABASES={})

from ocr.schemas import InvoiceItem, InvoiceSummary, InvoiceOCRResult
from ocr.validator import InvoiceValidator, _approx_equal


def _item(
    name="Chicken Ball",
    matched="Chicken Ball",
    score=95.0,
    qty=2.0,
    unit="Pack",
    unit_price=605.005,   # after-tax per unit = total / qty = 1210.01 / 2
    rate=526.09,           # pre-tax Rate column
    amount=1052.18,        # qty × rate = 2 × 526.09
    vat=157.83,
    total=1210.01,         # amount + vat = 1052.18 + 157.83
) -> InvoiceItem:
    return InvoiceItem(
        product_name=name,
        matched_product=matched,
        match_score=score,
        quantity=qty,
        unit=unit,
        unit_price=unit_price,
        rate=rate,
        amount=amount,
        vat=vat,
        total=total,
    )


def _summary(subtotal=1052.18, vat=157.83, grand_total=1210.01) -> InvoiceSummary:
    return InvoiceSummary(subtotal=subtotal, vat=vat, grand_total=grand_total)


def _result(items=None, summary=None) -> InvoiceOCRResult:
    return InvoiceOCRResult(
        invoice_number="INV-001",
        invoice_date="2024-07-18",
        supplier="CP Bangladesh",
        customer="Test Outlet",
        items=items or [_item()],
        summary=summary or _summary(),
        warnings=[],
    )


class TestApproxEqual(unittest.TestCase):

    def test_exact(self):
        self.assertTrue(_approx_equal(100.0, 100.0, 0.05))

    def test_within_tolerance(self):
        self.assertTrue(_approx_equal(100.0, 104.0, 0.05))

    def test_outside_tolerance(self):
        self.assertFalse(_approx_equal(100.0, 110.0, 0.05))

    def test_zero_denominator(self):
        self.assertTrue(_approx_equal(0.0, 0.0, 0.05))
        self.assertFalse(_approx_equal(1.0, 0.0, 0.05))


class TestValidatorItemRules(unittest.TestCase):

    def setUp(self):
        self.v = InvoiceValidator(tolerance=0.05)

    def test_clean_item_no_warnings(self):
        # Consistent data: rate×qty=amount, amount+vat=total, unit_price=total/qty
        it = _item(qty=2.0, unit_price=605.005, rate=526.09, amount=1052.18,
                   vat=157.83, total=1210.01)
        r = _result(items=[it], summary=_summary(subtotal=1052.18, vat=157.83, grand_total=1210.01))
        warns = self.v.validate(r)
        self.assertEqual(warns, [])

    def test_qty_times_price_mismatch_flags_item(self):
        # rate × qty = 2 × 526.09 = 1052.18, but amount is 999.00 → Rule 1 fires
        it = _item(qty=2.0, rate=526.09, amount=999.00, vat=157.83, total=1156.83,
                   unit_price=578.415)  # 1156.83/2 — consistent with total
        r = _result(items=[it])
        warns = self.v.validate(r)
        flagged = [w for w in warns if "rate×qty" in w]
        self.assertTrue(flagged)
        self.assertTrue(it.is_flagged)

    def test_amount_plus_vat_mismatch_flags_item(self):
        # amount + vat should ≈ total; 1052.18 + 157.83 = 1210.01 but total = 999
        it = _item(qty=2.0, unit_price=526.09, amount=1052.18, vat=157.83, total=999.00)
        r = _result(items=[it])
        warns = self.v.validate(r)
        flagged = [w for w in warns if "amount+vat" in w]
        self.assertTrue(flagged)

    def test_negative_quantity_flagged(self):
        it = _item(qty=-1.0)
        r = _result(items=[it])
        warns = self.v.validate(r)
        self.assertTrue(any("quantity" in w for w in warns))

    def test_none_values_skipped(self):
        """Missing (None) fields should not raise errors."""
        it = InvoiceItem(
            product_name="X", matched_product="X", match_score=90.0,
            quantity=None, unit="Pack", unit_price=None,
            amount=None, vat=None, total=100.0,
        )
        r = _result(items=[it])
        # Should not raise
        self.v.validate(r)


class TestValidatorSummaryRules(unittest.TestCase):

    def setUp(self):
        self.v = InvoiceValidator(tolerance=0.05)

    def test_subtotal_plus_vat_matches_grand_total(self):
        # 1052.18 + 157.83 = 1210.01 — all match
        s = _summary(subtotal=1052.18, vat=157.83, grand_total=1210.01)
        r = _result(summary=s)
        warns = self.v.validate(r)
        summary_warns = [w for w in warns if "subtotal+vat" in w]
        self.assertEqual(summary_warns, [])

    def test_subtotal_plus_vat_mismatch(self):
        # subtotal + vat = 1210.01, but grand_total = 2000 → flag
        s = _summary(subtotal=1052.18, vat=157.83, grand_total=2000.00)
        r = _result(summary=s)
        warns = self.v.validate(r)
        self.assertTrue(any("subtotal+vat" in w for w in warns))

    def test_sum_of_totals_vs_grand_total(self):
        items = [
            _item(total=600.0, amount=500.0, vat=100.0),
            _item(total=400.0, amount=350.0, vat=50.0),
        ]
        s = _summary(subtotal=850.0, vat=150.0, grand_total=1000.0)
        r = _result(items=items, summary=s)
        warns = self.v.validate(r)
        sum_warns = [w for w in warns if "sum of line totals" in w]
        self.assertEqual(sum_warns, [])  # 600+400 = 1000 ✓

    def test_sum_of_totals_mismatch(self):
        items = [
            _item(total=600.0, amount=500.0, vat=100.0),
            _item(total=400.0, amount=350.0, vat=50.0),
        ]
        s = _summary(subtotal=850.0, vat=150.0, grand_total=5000.0)
        r = _result(items=items, summary=s)
        warns = self.v.validate(r)
        self.assertTrue(any("sum of line totals" in w for w in warns))

    def test_none_summary_no_crash(self):
        s = InvoiceSummary(subtotal=None, vat=None, grand_total=None)
        r = _result(summary=s)
        self.v.validate(r)


class TestValidatorMatchScoreRule(unittest.TestCase):

    def setUp(self):
        self.v = InvoiceValidator(min_match_score=70.0)

    def test_low_score_warning(self):
        it = _item(matched="Some Product", score=50.0)
        r = _result(items=[it])
        warns = self.v.validate(r)
        self.assertTrue(any("low match confidence" in w for w in warns))

    def test_high_score_no_warning(self):
        it = _item(matched="Some Product", score=95.0)
        r = _result(items=[it])
        warns = self.v.validate(r)
        score_warns = [w for w in warns if "low match confidence" in w]
        self.assertEqual(score_warns, [])

    def test_empty_matched_no_score_warning(self):
        """If matched_product is empty (no catalog), don't warn about score."""
        it = _item(matched="", score=0.0)
        r = _result(items=[it])
        warns = self.v.validate(r)
        score_warns = [w for w in warns if "low match confidence" in w]
        self.assertEqual(score_warns, [])


if __name__ == "__main__":
    unittest.main()
