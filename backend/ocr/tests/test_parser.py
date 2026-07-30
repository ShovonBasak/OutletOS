"""Unit tests for ocr.parser — InvoiceParser.

Tests use synthetic OCR output (dicts / lists) so PaddleOCR is never loaded.
"""
import unittest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from django.conf import settings
if not settings.configured:
    settings.configure(INSTALLED_APPS=[], DATABASES={})

from ocr.parser import InvoiceParser, _rows_to_items, _extract_slip_totals


# ---------------------------------------------------------------------------
# Helpers to build synthetic inputs
# ---------------------------------------------------------------------------


def _make_table_region(html: str) -> dict:
    return {"type": "table", "bbox": [0, 0, 100, 100], "res": {"html": html}}


def _make_text_region(texts: list[str]) -> dict:
    res = [{"text": t, "confidence": 0.99} for t in texts]
    return {"type": "text", "bbox": [0, 0, 100, 50], "res": res}


_SAMPLE_TABLE_HTML = """
<table>
  <tr><td>SL</td><td>Product / Service Name Details</td><td>Qty</td>
      <td>Unit</td><td>Rate</td><td>Value</td><td>VAT</td><td>Total</td></tr>
  <tr><td>1</td><td>Chicken Pop Stick FPP Chilled</td><td>2</td>
      <td>Pack</td><td>526.09</td><td>1052.18</td><td>157.83</td><td>1209.83</td></tr>
  <tr><td>2</td><td>Burger Bun 6pcs</td><td>5</td>
      <td>Pack</td><td>120.00</td><td>600.00</td><td>90.00</td><td>690.00</td></tr>
  <tr><td></td><td>Sub Total</td><td></td><td></td><td></td><td>1652.18</td><td></td><td></td></tr>
  <tr><td></td><td>VAT</td><td></td><td></td><td></td><td></td><td>247.83</td><td></td></tr>
  <tr><td></td><td>Grand Total</td><td></td><td></td><td></td><td></td><td></td><td>1899.83</td></tr>
</table>
"""


class TestRowsToItems(unittest.TestCase):

    def _parse_table(self, html: str) -> list[dict]:
        from ocr.parser import _html_to_rows
        rows = _html_to_rows(html)
        return _rows_to_items(rows)

    def test_extracts_two_items(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertEqual(len(items), 2)

    def test_product_name(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertEqual(items[0]["product_name"], "Chicken Pop Stick FPP Chilled")

    def test_quantity(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["quantity"], 2.0)

    def test_unit_price(self):
        # unit_price is now after-tax per unit = total ÷ qty = 1209.83 ÷ 2 = 604.915
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["unit_price"], 604.915)

    def test_rate(self):
        # rate is the pre-tax Rate column value (for validation only)
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["rate"], 526.09)

    def test_amount(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["amount"], 1052.18)

    def test_vat(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["vat"], 157.83)

    def test_total(self):
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        self.assertAlmostEqual(items[0]["total"], 1209.83)

    def test_skips_summary_rows(self):
        """Grand Total / Sub Total / VAT rows must not appear as items."""
        items = self._parse_table(_SAMPLE_TABLE_HTML)
        names = [it["product_name"] for it in items]
        self.assertNotIn("Grand Total", names)
        self.assertNotIn("Sub Total", names)
        self.assertNotIn("VAT", names)

    def test_no_items_for_empty_table(self):
        self.assertEqual(_rows_to_items([]), [])

    def test_no_items_for_header_only(self):
        rows = [["SL", "Name", "Qty", "Unit", "Rate", "Value", "VAT", "Total"]]
        self.assertEqual(_rows_to_items(rows), [])

    def test_column_numbering_row_skipped(self):
        """A second header row with column numbers (1, 2, 3…) must be ignored."""
        from ocr.parser import _html_to_rows
        html = """
        <table>
          <tr><td>No.</td><td>Product Name</td><td>Qty</td>
              <td>Unit</td><td>Rate</td><td>Total value including Vat &amp; Tax</td></tr>
          <tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr>
          <tr><td>1</td><td>Chicken Pop Stick</td><td>6</td>
              <td>Pack</td><td>526.09</td><td>3630.14</td></tr>
          <tr><td>2</td><td>Karaage Chicken</td><td>3</td>
              <td>Pack</td><td>800.00</td><td>2760.00</td></tr>
        </table>
        """
        rows = _html_to_rows(html)
        items = _rows_to_items(rows)
        self.assertEqual(len(items), 2,
                         "Column-numbering row must not produce an item")
        self.assertEqual(items[1]["product_name"], "Karaage Chicken")
        self.assertAlmostEqual(items[1]["quantity"], 3.0,
                               msg="Karaage Chicken qty should be 3, not SL=2")

    def test_total_value_including_vat_maps_to_total(self):
        """'Total value including Vat & Tax' must map to the 'total' role, not 'value'."""
        from ocr.parser import _html_to_rows
        html = """
        <table>
          <tr><td>SL</td><td>Product Name</td><td>Qty</td>
              <td>Rate</td><td>Value</td><td>Total value including Vat &amp; Tax (Taka)</td></tr>
          <tr><td>1</td><td>Chicken Ball</td><td>2</td>
              <td>526.09</td><td>1052.18</td><td>1209.83</td></tr>
        </table>
        """
        rows = _html_to_rows(html)
        items = _rows_to_items(rows)
        self.assertEqual(len(items), 1)
        # unit_price = last-column total ÷ qty = 1209.83 ÷ 2 = 604.915
        self.assertAlmostEqual(items[0]["total"], 1209.83)
        self.assertAlmostEqual(items[0]["unit_price"], 604.915,
                               msg="unit_price must use after-VAT total column")

    def test_total_amount_pre_tax_not_used_as_line_total(self):
        """Full BD invoice layout: 'Total Amount' (pre-tax) must not block
        'Total Value incl. VAT & Tax' (after-tax) from being the line_total.
        The rightmost/last 'total' column must always win."""
        from ocr.parser import _html_to_rows
        html = """
        <table>
          <tr>
            <td>No.</td><td>Product Name</td><td>Qty</td><td>Unit</td>
            <td>Per Unit Price</td><td>Total Amount</td>
            <td>SD Rate</td><td>SD Amount</td>
            <td>VAT Rate</td><td>VAT Amount</td>
            <td>Total Value including VAT &amp; Tax</td>
          </tr>
          <tr>
            <td>1</td><td>2</td><td>3</td><td>4</td>
            <td>5</td><td>6</td><td>7</td><td>8</td>
            <td>9</td><td>10</td><td>11</td>
          </tr>
          <tr>
            <td>1</td><td>Karaage Chicken</td><td>3.00</td><td>Pack</td>
            <td>800.00</td><td>2400.00</td>
            <td>0</td><td>0.00</td>
            <td>15</td><td>360.00</td>
            <td>2760.00</td>
          </tr>
        </table>
        """
        rows = _html_to_rows(html)
        items = _rows_to_items(rows)
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertAlmostEqual(item["quantity"], 3.0)
        # Total Amount (pre-tax subtotal) → amount field, NOT line_total
        self.assertAlmostEqual(item["amount"], 2400.0,
                               msg="'Total Amount' must be stored as pre-tax amount")
        # Total Value incl. VAT (after-tax) → total and line_total
        self.assertAlmostEqual(item["total"], 2760.0,
                               msg="'Total Value incl. VAT' must be the after-tax total")
        # unit_price = after-tax total ÷ qty = 2760 ÷ 3 = 920
        self.assertAlmostEqual(item["unit_price"], 920.0,
                               msg="unit_price must use the after-tax column, not Total Amount")

    def test_qty_corrected_when_decimal_dropped_by_ocr(self):
        """OCR sometimes reads '2.00' as '200' (drops decimal point).
        When qty × rate diverges from total_amount by >5%, back-compute
        qty = total_amount ÷ rate so the corrected value is used."""
        from ocr.parser import _html_to_rows
        html = """
        <table>
          <tr><td>SL</td><td>Product Name</td><td>Qty</td>
              <td>Unit</td><td>Rate</td><td>Value</td><td>VAT</td><td>Total</td></tr>
          <tr><td>1</td><td>Chicken Nugget</td><td>200</td>
              <td>Pack</td><td>350.00</td><td>700.00</td><td>105.00</td><td>805.00</td></tr>
        </table>
        """
        rows = _html_to_rows(html)
        items = _rows_to_items(rows)
        self.assertEqual(len(items), 1)
        # qty=200 × rate=350 = 70000 ≠ total_amount=700 → back-compute: 700÷350 = 2
        self.assertAlmostEqual(items[0]["quantity"], 2.0,
                               msg="qty should be corrected to 2.0 via total_amount÷rate")
        # unit_price should use the corrected qty: 805 ÷ 2 = 402.5
        self.assertAlmostEqual(items[0]["unit_price"], 402.5,
                               msg="unit_price must use corrected qty")

    def test_no_header_sl_not_used_as_qty(self):
        """SL serial number must never appear as the item quantity.

        When the header is ["No.", "Name", "Qty", ...], "No." must be detected
        as the SL (serial) column and row-counter values ("1", "2") must be
        discarded, not treated as qty.
        """
        from ocr.parser import _html_to_rows
        html = """
        <table>
          <tr><td>No.</td><td>Product Name</td><td>Qty</td>
              <td>Unit</td><td>Rate</td><td>Total</td></tr>
          <tr><td>1</td><td>Chicken Pop Stick</td><td>6</td>
              <td>Pack</td><td>526.09</td><td>3156.54</td></tr>
          <tr><td>2</td><td>Karaage Chicken</td><td>3</td>
              <td>Pack</td><td>800.00</td><td>2400.00</td></tr>
        </table>
        """
        rows = _html_to_rows(html)
        items = _rows_to_items(rows)
        self.assertEqual(len(items), 2)
        # Quantities must be the Qty column values, not the SL serial numbers
        self.assertAlmostEqual(items[0]["quantity"], 6.0,
                               msg="Row 1 qty should be 6, not SL=1")
        self.assertAlmostEqual(items[1]["quantity"], 3.0,
                               msg="Row 2 qty should be 3, not SL=2")


class TestExtractSlipTotals(unittest.TestCase):

    def setUp(self):
        from ocr.parser import _html_to_rows
        self.rows = _html_to_rows(_SAMPLE_TABLE_HTML)

    def test_subtotal(self):
        totals = _extract_slip_totals(self.rows)
        self.assertAlmostEqual(totals["subtotal"], 1652.18)

    def test_vat(self):
        totals = _extract_slip_totals(self.rows)
        self.assertAlmostEqual(totals["vat"], 247.83)

    def test_grand_total(self):
        totals = _extract_slip_totals(self.rows)
        self.assertAlmostEqual(totals["grand_total"], 1899.83)


class TestInvoiceParserFullPass(unittest.TestCase):
    """Integration test: parser with synthetic layout_result."""

    def _run(self, layout, text_result=None):
        parser = InvoiceParser()
        return parser.parse(layout, text_result or [], (1000, 800, 3))

    def test_items_extracted(self):
        layout = [
            _make_table_region(_SAMPLE_TABLE_HTML),
            _make_text_region(["Invoice No: INV-2024-001", "Invoice Date: 2024-07-18",
                                "Sold by: CP Bangladesh"]),
        ]
        result = self._run(layout)
        self.assertEqual(len(result["items"]), 2)

    def test_date_extracted(self):
        layout = [
            _make_table_region(_SAMPLE_TABLE_HTML),
            _make_text_region(["Invoice Date: 2024-07-18"]),
        ]
        result = self._run(layout)
        self.assertEqual(result["invoice_date"], "2024-07-18")

    def test_invoice_number_extracted(self):
        layout = [
            _make_text_region(["Invoice No: INV-2024-001"]),
        ]
        result = self._run(layout)
        self.assertEqual(result["invoice_number"], "INV-2024-001")

    def test_supplier_extracted(self):
        layout = [
            _make_text_region(["Sold by: CP Bangladesh"]),
        ]
        result = self._run(layout)
        self.assertIn("CP Bangladesh", result["supplier"])

    def test_empty_layout_no_crash(self):
        result = self._run([])
        self.assertIsInstance(result["items"], list)

    def test_text_ocr_fallback(self):
        """When layout has no table, text_result is used as fallback."""
        # Simulate positional text OCR output: [bbox, (text, confidence)]
        def _line(x_c, y_c, text):
            half = 30
            bbox = [[x_c - half, y_c - 8], [x_c + half, y_c - 8],
                    [x_c + half, y_c + 8], [x_c - half, y_c + 8]]
            return [bbox, (text, 0.99)]

        header_y = 100
        data_y = 130
        text_result = [
            # Header row
            _line(50, header_y, "SL"),
            _line(200, header_y, "Name"),
            _line(350, header_y, "Qty"),
            _line(450, header_y, "Unit"),
            _line(550, header_y, "Rate"),
            _line(650, header_y, "Total"),
            # Data row
            _line(50, data_y, "1"),
            _line(200, data_y, "Chicken Ball"),
            _line(350, data_y, "3"),
            _line(450, data_y, "Pack"),
            _line(550, data_y, "200.00"),
            _line(650, data_y, "600.00"),
        ]
        result = self._run([], text_result)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["product_name"], "Chicken Ball")
        self.assertAlmostEqual(result["items"][0]["quantity"], 3.0)
        self.assertAlmostEqual(result["items"][0]["total"], 600.0)


if __name__ == "__main__":
    unittest.main()
