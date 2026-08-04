"""Fixed constants for CP Bangladesh tax-invoice parsing.

Invoice column layout (standard):
    SL | Product / Service Name Details | Qty | Unit | Rate | Value | VAT | Total
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Column role keyword sets
# ---------------------------------------------------------------------------

NAME_KW = frozenset([
    "product", "service", "name", "description", "item", "particulars",
    "goods", "details",
])
QTY_KW = frozenset(["qty", "quantity"])
UNIT_KW = frozenset(["unit", "uom", "measure"])
RATE_KW  = frozenset(["rate", "price"])
VALUE_KW = frozenset(["value"])      # line subtotal before VAT
VAT_KW   = frozenset(["vat", "tax"])
TOTAL_KW = frozenset(["total"])      # line total after VAT
SD_KW    = frozenset(["sd", "supplementary"])  # Bangladesh Supplementary Duty

# Combined set used for header-row detection (≥2 hits → it's a header)
ALL_HEADER_KW = frozenset([
    "qty", "quantity", "rate", "price", "total", "name", "product",
    "item", "service", "particulars", "value", "vat", "tax", "unit",
    "sl", "no", "description", "details", "goods",
])

# Ordered role-detection list: (keyword_set, role_name)
# NOTE: _detect_columns() checks combined vat+rate → "vat_rate" BEFORE iterating
# this list, so the VAT Rate column is handled in code, not here.
# "no" positional disambiguation (first col = SL, later col = qty) is also in code.
COL_ROLE_MAP: list[tuple[frozenset, str]] = [
    (frozenset(["sl", "#", "sn"]),                  "sl"),
    (NAME_KW,                                        "name"),
    (QTY_KW,                                         "qty"),
    (RATE_KW,                                        "rate"),   # before UNIT (handles "Per Unit Price")
    (UNIT_KW,                                        "unit"),
    (TOTAL_KW,                                       "total"),  # before VALUE so "Total value incl. VAT" → total
    (VALUE_KW,                                       "value"),
    (VAT_KW,                                         "vat"),
]

# ---------------------------------------------------------------------------
# Row-level skip patterns (summary / footer rows)
# ---------------------------------------------------------------------------

GRAND_TOTAL_RE    = re.compile(r"\bgrand\s*total\b|\bমোট\s*চালান\b|\bমোট\s*মূল্য\b", re.I)
SUBTOTAL_RE       = re.compile(r"\bsub\s*-?\s*total\b|\bsubtotal\b", re.I)
VAT_TOTAL_RE      = re.compile(r"\bvat\b|\btax\b", re.I)
DISCOUNT_TOTAL_RE = re.compile(r"\btotal\s*discount\b|\bমোট\s*ডিসকাউন্ট\b", re.I)
SKIP_ROW_RE = re.compile(
    r"\b(total|vat|tax|sub\s*-?\s*total|grand|discount|"
    r"delivery|charge|shipping|freight|service)\b",
    re.I,
)

# ---------------------------------------------------------------------------
# Header-field extraction
# ---------------------------------------------------------------------------

INVOICE_NO_RE = re.compile(
    r"(?:invoice|bill|challan|inv|chln)[\s#:.\-no]*(\w[\w/\-]*)",
    re.I,
)
DATE_LABEL_RE = re.compile(
    r"\b(date|dated|invoice\s*date|delivery\s*date)\b",
    re.I,
)
SUPPLIER_LABEL_RE = re.compile(
    r"\b(sold\s*by|supplier|vendor|from)\s*[:\-]?\s*(.+)",
    re.I,
)
CUSTOMER_LABEL_RE = re.compile(
    r"\b(sold\s*to|bill\s*to|ship\s*to|customer|buyer)\s*[:\-]?\s*(.+)",
    re.I,
)

# Known CP Bangladesh supplier name patterns
CP_SUPPLIER_RE = re.compile(
    r"\bCP\s+(?:Bangladesh|Five\s+Star|Five\*)\b",
    re.I,
)

# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

MONTH_MAP: dict[str, int] = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10,
    "november": 11, "december": 12,
}

DATE_PATTERNS: list[re.Pattern] = [
    re.compile(r"(?P<y>\d{4})[-/](?P<m>\d{1,2})[-/](?P<d>\d{1,2})"),
    re.compile(r"(?P<d>\d{1,2})[-/](?P<m>\d{1,2})[-/](?P<y>\d{4})"),
    re.compile(r"(?P<d>\d{1,2})\s+(?P<mn>[A-Za-z]{3,9})\s+(?P<y>\d{4})"),
    re.compile(r"(?P<mn>[A-Za-z]{3,9})\s+(?P<d>\d{1,2}),?\s+(?P<y>\d{4})"),
]

# ---------------------------------------------------------------------------
# Number parsing
# ---------------------------------------------------------------------------

# Matches the first number token in a cell (allows digits, dots, commas)
NUMBER_RE = re.compile(r"\d[\d,.]*")
# Currency symbols to strip before parsing
CURRENCY_STRIP_RE = re.compile(r"[৳৳TtKkBD]+", re.ASCII)
