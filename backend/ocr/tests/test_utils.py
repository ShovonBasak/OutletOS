"""Unit tests for ocr.utils — number normalisation and date extraction."""
import unittest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
# Patch minimal Django settings so constants.py can import without django.setup()
import django
from django.conf import settings
if not settings.configured:
    settings.configure(INSTALLED_APPS=[], DATABASES={})

from ocr.utils import normalize_number, extract_date


class TestNormalizeNumber(unittest.TestCase):
    """normalize_number() must handle OCR decimal/thousands ambiguity."""

    def _n(self, s, expected):
        self.assertAlmostEqual(normalize_number(s), expected, places=4, msg=f"Input: {s!r}")

    def test_plain_integer(self):
        self._n("200", 200.0)

    def test_plain_decimal(self):
        self._n("2.00", 2.0)

    def test_comma_as_decimal(self):
        """OCR misreads '.' as ',' → '2,00' must become 2.00, not 200."""
        self._n("2,00", 2.0)

    def test_comma_as_decimal_one_digit(self):
        self._n("1,5", 1.5)

    def test_comma_as_thousands(self):
        """Three digits after comma → thousands separator."""
        self._n("1,234", 1234.0)

    def test_comma_thousands_with_decimal(self):
        self._n("1,234.56", 1234.56)

    def test_european_format(self):
        """Dot as thousands, comma as decimal."""
        self._n("1.234,56", 1234.56)

    def test_currency_prefix_taka(self):
        self._n("৳ 1,500", 1500.0)

    def test_currency_prefix_bdt(self):
        self._n("BDT 526.09", 526.09)

    def test_large_price(self):
        self._n("12,701.00", 12701.0)

    def test_returns_none_for_empty(self):
        self.assertIsNone(normalize_number(""))

    def test_returns_none_for_zero(self):
        self.assertIsNone(normalize_number("0"))

    def test_returns_none_for_text_only(self):
        self.assertIsNone(normalize_number("N/A"))

    def test_strips_taka_and_parses(self):
        self._n("৳2,500.00", 2500.0)


class TestExtractDate(unittest.TestCase):

    def test_iso_format(self):
        self.assertEqual(extract_date(["Date: 2024-07-18"]), "2024-07-18")

    def test_dd_mm_yyyy(self):
        self.assertEqual(extract_date(["18/07/2024"]), "2024-07-18")

    def test_dd_month_yyyy(self):
        self.assertEqual(extract_date(["18 July 2024"]), "2024-07-18")

    def test_labelled_preferred(self):
        # Labelled date (with "date:") should win over unlabelled
        blocks = ["Reference: 2020-01-01", "Invoice Date: 2024-07-18"]
        self.assertEqual(extract_date(blocks), "2024-07-18")

    def test_returns_empty_for_no_date(self):
        self.assertEqual(extract_date(["No date here"]), "")

    def test_multiple_unlabelled_picks_most_recent(self):
        blocks = ["2023-01-01", "2024-07-18"]
        self.assertEqual(extract_date(blocks), "2024-07-18")


if __name__ == "__main__":
    unittest.main()
