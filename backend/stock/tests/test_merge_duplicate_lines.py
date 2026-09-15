"""Unit tests for stock.services.merge_duplicate_stock_in_lines.

Run with: python manage.py test stock.tests.test_merge_duplicate_lines
"""
from django.test import SimpleTestCase

from stock.services import merge_duplicate_stock_in_lines


def _item(**kw):
    base = {
        "matched_ingredient": None, "unit": "PACK", "quantity": None,
        "raw_text": "", "rate": None, "total_amount": None, "discount": None,
        "sd_rate": None, "sd_amount": None, "vat_rate": None, "vat_amount": None,
        "line_total": None,
    }
    base.update(kw)
    return base


class TestMergeDuplicateStockInLines(SimpleTestCase):
    def test_same_ingredient_and_unit_merged(self):
        items = [
            _item(matched_ingredient="Burger Bun 60 g", unit="PACK", quantity=3,
                  total_amount=300, raw_text="BUN x3"),
            _item(matched_ingredient="Burger Bun 60 g", unit="PACK", quantity=2,
                  total_amount=200, raw_text="BUN x2"),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["quantity"], 5)
        self.assertEqual(merged[0]["total_amount"], 500)
        self.assertEqual(len(warnings), 1)

    def test_case_and_whitespace_insensitive_match(self):
        items = [
            _item(matched_ingredient="Burger Bun 60 g", unit="pack", quantity=1),
            _item(matched_ingredient=" burger bun 60 g ", unit="PACK", quantity=1),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["quantity"], 2)

    def test_same_ingredient_different_unit_not_merged(self):
        items = [
            _item(matched_ingredient="Sweet Chilli Sauce", unit="PACK", quantity=2),
            _item(matched_ingredient="Sweet Chilli Sauce", unit="PIECE", quantity=50),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 2)
        self.assertEqual(warnings, [])

    def test_unresolved_lines_never_merged(self):
        items = [
            _item(matched_ingredient=None, raw_text="Unknown A", quantity=1),
            _item(matched_ingredient=None, raw_text="Unknown B", quantity=1),
            _item(matched_ingredient="", raw_text="Unknown C", quantity=1),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 3)
        self.assertEqual(warnings, [])

    def test_different_ingredients_not_merged(self):
        items = [
            _item(matched_ingredient="Burger Bun 60 g", unit="PACK", quantity=1),
            _item(matched_ingredient="Chicken Fried Rice", unit="PACK", quantity=1),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 2)

    def test_rate_and_discount_carried_through(self):
        items = [
            _item(matched_ingredient="Coca Cola 250ml", unit="PACK", quantity=2,
                  total_amount=100, discount=10, rate=50),
            _item(matched_ingredient="Coca Cola 250ml", unit="PACK", quantity=1,
                  total_amount=50, discount=5, rate=None),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 1)
        row = merged[0]
        self.assertEqual(row["quantity"], 3)
        self.assertEqual(row["total_amount"], 150)
        self.assertEqual(row["discount"], 15)
        self.assertEqual(row["rate"], 50)  # first non-null kept, not summed

    def test_empty_input(self):
        merged, warnings = merge_duplicate_stock_in_lines([])
        self.assertEqual(merged, [])
        self.assertEqual(warnings, [])

    def test_no_duplicates_passthrough(self):
        items = [
            _item(matched_ingredient="A", unit="PACK", quantity=1),
            _item(matched_ingredient="B", unit="PACK", quantity=2),
            _item(matched_ingredient="C", unit="PIECE", quantity=3),
        ]
        merged, warnings = merge_duplicate_stock_in_lines(items)
        self.assertEqual(len(merged), 3)
        self.assertEqual(warnings, [])
