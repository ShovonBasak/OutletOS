"""Unit tests for ai_extraction.verify_and_correct — deterministic math reconciliation.

verify_and_correct is a pure function (no Django, no Claude), so these tests import
it directly without app setup or an API key.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from catalog.ai_extraction import verify_and_correct


def _item(**kw):
    base = {
        "raw_text": "X", "matched_ingredient": None, "quantity": None, "unit": "PACK",
        "rate": None, "total_amount": None, "sd_rate": None, "sd_amount": None,
        "vat_rate": None, "vat_amount": None, "line_total": None,
    }
    base.update(kw)
    return base


class TestQtyCorrection(unittest.TestCase):
    def test_ocr_decimal_drop_corrected(self):
        # Chicken Nugget: OCR read qty as 200, but rate 350 × qty should equal 700.
        parsed = {"items": [_item(quantity=200, rate=350.0, total_amount=700.0,
                                  vat_amount=105.0, line_total=805.0)]}
        out = verify_and_correct(parsed)
        it = out["items"][0]
        self.assertAlmostEqual(it["quantity"], 2.0)
        self.assertAlmostEqual(it["unit_price"], 402.5)  # 805 ÷ 2
        self.assertTrue(any("corrected" in f for f in it["flags"]))

    def test_correct_qty_left_untouched(self):
        parsed = {"items": [_item(quantity=3, rate=800.0, total_amount=2400.0,
                                  vat_amount=360.0, line_total=2760.0)]}
        out = verify_and_correct(parsed)
        it = out["items"][0]
        self.assertAlmostEqual(it["quantity"], 3.0)
        self.assertAlmostEqual(it["unit_price"], 920.0)  # 2760 ÷ 3
        self.assertEqual(it["flags"], [])

    def test_paper_bag_hundred_to_one(self):
        # Brown paper bag: qty 100 misread, rate 93 × 1 = 93.
        parsed = {"items": [_item(quantity=100, rate=93.0, total_amount=93.0,
                                  vat_amount=6.98, line_total=99.98)]}
        out = verify_and_correct(parsed)
        self.assertAlmostEqual(out["items"][0]["quantity"], 1.0)


class TestBackfill(unittest.TestCase):
    def test_total_amount_backfilled(self):
        parsed = {"items": [_item(quantity=5, rate=480.0, vat_amount=360.0)]}
        out = verify_and_correct(parsed)
        it = out["items"][0]
        self.assertAlmostEqual(it["total_amount"], 2400.0)     # 5 × 480
        self.assertAlmostEqual(it["line_total"], 2760.0)       # 2400 + 360
        self.assertAlmostEqual(it["unit_price"], 552.0)        # 2760 ÷ 5

    def test_line_total_backfilled_with_sd(self):
        parsed = {"items": [_item(quantity=2, rate=100.0, total_amount=200.0,
                                  sd_amount=20.0, vat_amount=33.0)]}
        out = verify_and_correct(parsed)
        self.assertAlmostEqual(out["items"][0]["line_total"], 253.0)  # 200+20+33


class TestFlagging(unittest.TestCase):
    def test_line_total_mismatch_flagged(self):
        parsed = {"items": [_item(quantity=2, rate=100.0, total_amount=200.0,
                                  sd_amount=0.0, vat_amount=30.0, line_total=999.0)]}
        out = verify_and_correct(parsed)
        self.assertTrue(any("line_total" in f for f in out["items"][0]["flags"]))

    def test_slip_totals_reconcile_flag(self):
        parsed = {"items": [], "subtotal": 6176.0, "vat_total": 912.0, "grand_total": 9999.0}
        out = verify_and_correct(parsed)
        self.assertTrue(any("grand_total" in f for f in out["flags"]))

    def test_slip_totals_ok_no_flag(self):
        parsed = {"items": [], "subtotal": 6176.0, "vat_total": 912.0, "grand_total": 7088.0}
        out = verify_and_correct(parsed)
        self.assertEqual(out["flags"], [])


class TestRobustness(unittest.TestCase):
    def test_missing_fields_no_crash(self):
        parsed = {"items": [_item(raw_text="Signature")]}
        out = verify_and_correct(parsed)  # all-None row
        self.assertIsNone(out["items"][0]["quantity"])
        self.assertEqual(out["items"][0]["flags"], [])

    def test_string_numbers_parsed(self):
        parsed = {"items": [_item(quantity="200", rate="350.00", total_amount="700.00")]}
        out = verify_and_correct(parsed)
        self.assertAlmostEqual(out["items"][0]["quantity"], 2.0)


if __name__ == "__main__":
    unittest.main()
