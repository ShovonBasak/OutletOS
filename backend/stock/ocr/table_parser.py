"""
Parse HTML tables from PP-StructureV3 output into structured row/column data,
then map columns to the CP Bangladesh tax-invoice schema.

CP invoice column layout:
    SL | Product / Service Name Details | Qty | Unit | Rate | Value | VAT | Total

We keyword-match each header cell to one of these roles:
    "name"  → ingredient/product name
    "qty"   → delivered quantity
    "unit"  → unit of measure (Pcs, Kg, …)
    "rate"  → unit price before tax
    "value" → line subtotal (qty × rate, before tax)
    "vat"   → VAT/tax amount for this line
    "total" → line total after tax

Everything else (SL, serial no) is ignored.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser


# ---------------------------------------------------------------------------
# HTML table → list-of-rows
# ---------------------------------------------------------------------------

class _TableParser(HTMLParser):
    """Minimal HTML table parser. Handles <thead>/<tbody> as transparent wrappers."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] = []
        self._cell: list[str] = []
        self._in_cell = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
            self._in_cell = True
        elif tag == "br" and self._in_cell:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._row.append(" ".join(p for p in self._cell if p.strip()).strip())
            self._in_cell = False
        elif tag == "tr" and self._row:
            self.rows.append(self._row[:])
            self._row = []

    def handle_data(self, data):
        if self._in_cell:
            self._cell.append(data)


def html_to_rows(html: str) -> list[list[str]]:
    """Parse an HTML table string (from PP-Structure) into a list of row lists."""
    parser = _TableParser()
    parser.feed(html)
    return parser.rows


# ---------------------------------------------------------------------------
# Column role detection
# ---------------------------------------------------------------------------

_NAME_KW  = frozenset(["product", "service", "name", "details", "description",
                        "item", "particulars", "goods"])
_QTY_KW   = frozenset(["qty", "quantity"])
_UNIT_KW  = frozenset(["unit", "uom", "measure"])
_RATE_KW  = frozenset(["rate", "price", "each"])
_VALUE_KW = frozenset(["value"])              # line subtotal before tax
_VAT_KW   = frozenset(["vat", "tax"])
_TOTAL_KW = frozenset(["total"])              # line total after tax
_SD_KW    = frozenset(["sd", "supplementary"])  # Bangladesh Supplementary Duty

# Used ONLY for _is_header() keyword counting — not for column assignment.
_SKIP_KW  = frozenset(["sl", "no", "#", "rate", "value", "vat", "tax", "total",
                        "price", "subtotal", "sub", "grand", "discount", "charge"])


def _tokens(cell: str) -> set[str]:
    return set(re.sub(r"[^a-z0-9\s]", "", cell.lower()).split())


def _detect_columns(header: list[str]) -> dict[str, int]:
    """Return {role: col_index} for a header row.

    Roles: name, qty, unit, rate, vat_rate, value, vat, total, sl.

    Two-pass "no" resolution:
      "no" alone in a cell is ambiguous — it can be the SL column (row counter) or
      the qty column ("No. of pieces"). We defer all such cells, then in a second
      pass assign them based on context:
        • If a "qty"/"quantity" column is already found → all "no" cells = sl.
        • Single "no" with no other qty column → it becomes qty.
        • Multiple "no" cells, no other qty → leftmost = sl, rest = qty.

    Unambiguous SL markers (sl, #, sn) always map to "sl" immediately.
    Combined vat+rate → "vat_rate" is checked first to prevent misclassification.
    """
    col: dict[str, int] = {}
    no_deferred: list[int] = []  # column indices whose header is "no"-only

    for i, cell in enumerate(header):
        toks = _tokens(cell)

        # Rule 1: combined vat+rate → vat_rate (e.g. "VAT Rate", "Tax %")
        if (toks & _VAT_KW) and (toks & _RATE_KW):
            col.setdefault("vat_rate", i)
            continue

        # Rule 2: combined sd+rate → sd_rate (e.g. "SD Rate", "Supplementary Duty Rate")
        if (toks & _SD_KW) and (toks & _RATE_KW):
            col.setdefault("sd_rate", i)
            continue

        # Rule 3: combined sd+amount → sd_amount (e.g. "SD Amount")
        if (toks & _SD_KW) and ("amount" in toks):
            col.setdefault("sd_amount", i)
            continue

        # Rule 4: unambiguous SL markers → always "sl"
        if (toks & frozenset(["sl", "#", "sn"])) and not (toks & _NAME_KW):
            col.setdefault("sl", i)
            continue

        # Rule 5: "no" without any other disambiguating keyword → defer
        if "no" in toks and not (toks & (_NAME_KW | _QTY_KW)):
            no_deferred.append(i)
            continue

        if toks & _NAME_KW:
            col.setdefault("name", i)
        elif toks & _QTY_KW:
            col.setdefault("qty", i)
        elif toks & _RATE_KW:
            # Check RATE before UNIT so "Per Unit Price" → "rate" (not "unit")
            col.setdefault("rate", i)
        elif toks & _UNIT_KW:
            col.setdefault("unit", i)
        elif toks & _TOTAL_KW:
            # "Total Amount" (pre-tax subtotal, no VAT keyword) → "value" role.
            # Everything else (plain "Total", "Total Value incl. VAT & Tax") →
            # "total" role using overwrite (not setdefault) so that the rightmost
            # / last column always wins. This prevents "Total Amount" from
            # blocking the after-tax "Total Value" column that comes later.
            if "amount" in toks and not (toks & _VAT_KW):
                col.setdefault("value", i)   # "Total Amount" = pre-tax subtotal
            else:
                col["total"] = i             # overwrite → last/rightmost "total" wins
        elif toks & _VALUE_KW:
            col.setdefault("value", i)
        elif toks & _VAT_KW:
            col.setdefault("vat", i)

    # Second pass: resolve deferred "no" cells
    has_qty = "qty" in col
    for seq, i in enumerate(no_deferred):
        if has_qty:
            col.setdefault("sl", i)
        elif len(no_deferred) > 1 and seq == 0:
            col.setdefault("sl", i)   # leftmost of multiple → SL
        else:
            col.setdefault("qty", i)
            has_qty = True            # subsequent "no" cells → sl

    return col


def _is_header(row: list[str]) -> bool:
    all_kw = _NAME_KW | _QTY_KW | _UNIT_KW | _SKIP_KW
    hits = sum(1 for cell in row if _tokens(cell) & all_kw)
    return hits >= 2


# ---------------------------------------------------------------------------
# Extract items from row data
# ---------------------------------------------------------------------------

_SKIP_NAME_RE = re.compile(
    r"\b(total|vat|tax|sub\s*-?\s*total|grand|discount|delivery|charge|"
    r"shipping|freight|service|sgd|bdt)\b",
    re.I,
)


def extract_table_items(rows: list[list[str]]) -> list[dict]:
    """Convert table rows to item dicts.

    Returns list of:
        {
            "raw_text":     str,
            "raw_qty":      str,
            "raw_unit":     str,
            "raw_rate":     str,  # pre-tax unit price (Rate column)
            "raw_value":    str,  # line subtotal before tax (Value column)
            "raw_vat_rate": str,  # VAT rate % (e.g. "15%")
            "raw_vat":      str,  # VAT amount for this line
            "raw_total":    str,  # line total after tax (primary price source)
        }

    Empty / purely numeric / total/VAT rows are skipped.
    The SL (serial number) column is always discarded.
    """
    if not rows:
        return []

    # Find first recognisable header row
    header_idx = 0
    col: dict[str, int] = {}
    for i, row in enumerate(rows):
        cm = _detect_columns(row)
        if "name" in cm:
            header_idx = i
            col = cm
            break

    if "name" not in col:
        return []

    items = []
    for row in rows[header_idx + 1:]:
        # Skip column-numbering rows (a second header row like "1 | 2 | 3 | 4 | …"
        # that some CP Bangladesh invoices print below the column-name header).
        if row and all(not any(c.isalpha() for c in cell) for cell in row if cell.strip()):
            continue
        if not row:
            continue

        def _cell(role: str) -> str:
            idx = col.get(role)
            return row[idx].strip() if idx is not None and idx < len(row) else ""

        name = _cell("name")
        if not name or not any(c.isalpha() for c in name):
            continue
        if _SKIP_NAME_RE.search(name):
            continue

        items.append({
            "raw_text":      name,
            "raw_qty":       _cell("qty"),
            "raw_unit":      _cell("unit"),
            "raw_rate":      _cell("rate"),
            "raw_value":     _cell("value"),    # pre-tax subtotal (Total Amount)
            "raw_sd_rate":   _cell("sd_rate"),
            "raw_sd_amount": _cell("sd_amount"),
            "raw_vat_rate":  _cell("vat_rate"),
            "raw_vat":       _cell("vat"),
            "raw_total":     _cell("total"),    # after-tax total (Total Value incl. VAT)
        })

    return items


# ---------------------------------------------------------------------------
# Extract slip-level financial totals from all table rows
# ---------------------------------------------------------------------------

_GRAND_TOTAL_RE = re.compile(r"\bgrand\s*total\b", re.I)
_SUBTOTAL_RE    = re.compile(r"\bsub\s*-?\s*total\b|\bsubtotal\b", re.I)
_VAT_TOTAL_RE   = re.compile(r"\bvat\b|\btax\b", re.I)

_NUMBER_RE = re.compile(r"\d[\d,.]*")


def normalize_number_str(s: str) -> str:
    """Convert a raw OCR number string to a plain float-parseable string.

    Handles common OCR ambiguities on Bangladeshi tax invoices:
      "2,00"      → "2.00"   (OCR misread decimal point as comma)
      "1,234"     → "1234"   (thousands separator)
      "1,234.56"  → "1234.56"
      "1.234,56"  → "1234.56" (European decimal format)
      "200"       → "200"
      "2.00"      → "2.00"
    """
    s = s.strip()
    dot_idx   = s.rfind(".")
    comma_idx = s.rfind(",")

    if dot_idx == -1 and comma_idx == -1:
        return s  # plain integer, nothing to do

    if dot_idx > comma_idx:
        # e.g. "1,234.56" or "2.00" — dot is the rightmost separator → decimal
        return s.replace(",", "")

    # comma_idx > dot_idx
    if dot_idx == -1:
        # Only commas, no dot at all
        after_last_comma = s[comma_idx + 1:]
        if len(after_last_comma) <= 2:
            # e.g. "2,00" or "1,5" → comma = decimal point
            return s[:comma_idx] + "." + after_last_comma
        else:
            # e.g. "1,234" → comma = thousands separator
            return s.replace(",", "")
    else:
        # dot before comma: European format e.g. "1.234,56"
        return s.replace(".", "").replace(",", ".")


def _rightmost_number(row: list[str]) -> float | None:
    """Find the rightmost cell that contains a number and return it."""
    for cell in reversed(row):
        s = cell.replace("৳", "").replace("BDT", "").replace("Tk", "").strip()
        m = _NUMBER_RE.search(s)
        if not m:
            continue
        try:
            v = float(normalize_number_str(m.group()))
            if v > 0:
                return v
        except ValueError:
            pass
    return None


def extract_slip_totals(rows: list[list[str]]) -> dict:
    """Scan all table rows for Grand Total / Subtotal / VAT summary rows.

    Returns::

        {
            "subtotal":    float | None,
            "vat_total":   float | None,
            "grand_total": float | None,
        }
    """
    subtotal    = None
    vat_total   = None
    grand_total = None

    for row in rows:
        if not row:
            continue
        row_text = " ".join(cell.strip() for cell in row)
        if _GRAND_TOTAL_RE.search(row_text):
            val = _rightmost_number(row)
            if val is not None:
                grand_total = val
        elif _SUBTOTAL_RE.search(row_text):
            val = _rightmost_number(row)
            if val is not None:
                subtotal = val
        elif _VAT_TOTAL_RE.search(row_text):
            val = _rightmost_number(row)
            if val is not None and vat_total is None:
                vat_total = val

    return {"subtotal": subtotal, "vat_total": vat_total, "grand_total": grand_total}
