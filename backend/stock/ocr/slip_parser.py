"""
CP Bangladesh invoice-specific parser.

Consumes the raw PP-StructureV3 result list and produces a normalised dict:

    {
        "date":        "YYYY-MM-DD" | None,
        "subtotal":    float | None,   # slip subtotal before VAT
        "vat_total":   float | None,   # VAT amount on the slip
        "grand_total": float | None,   # grand total after VAT
        "items": [
            {
                "raw_text":   str,
                "quantity":   float | None,
                "unit":       "PACK" | "PIECE",
                "unit_price": float | None,   # rate per pack/piece before tax
                "line_total": float | None,   # total after tax for this line
            }
        ]
    }

Layout known for CP Five Star Bangladesh tax invoices:
    Text regions (header) → invoice date, customer details
    Table region          → SL | Product/Service Name | Qty | Unit | Rate | Value | VAT | Total
"""
from __future__ import annotations

import re
from datetime import date

from .table_parser import (
    _GRAND_TOTAL_RE,
    _SKIP_NAME_RE,
    _SUBTOTAL_RE,
    _VAT_TOTAL_RE,
    _NUMBER_RE,
    normalize_number_str,
    extract_slip_totals,
    extract_table_items,
    html_to_rows,
)


# ---------------------------------------------------------------------------
# Date extraction
# ---------------------------------------------------------------------------

_MONTH_MAP: dict[str, int] = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4,
    "june": 6, "july": 7, "august": 8, "september": 9,
    "october": 10, "november": 11, "december": 12,
}

# Capture groups always: year, month-num-or-name, day
_DATE_PATTERNS: list[re.Pattern] = [
    # YYYY-MM-DD  or  YYYY/MM/DD
    re.compile(r"(?P<y>\d{4})[-/](?P<m>\d{1,2})[-/](?P<d>\d{1,2})"),
    # DD/MM/YYYY  or  DD-MM-YYYY  (4-digit year is required to avoid qty columns)
    re.compile(r"(?P<d>\d{1,2})[-/](?P<m>\d{1,2})[-/](?P<y>\d{4})"),
    # "1 June 2024"
    re.compile(r"(?P<d>\d{1,2})\s+(?P<mn>[A-Za-z]{3,9})\s+(?P<y>\d{4})"),
    # "June 1, 2024"
    re.compile(r"(?P<mn>[A-Za-z]{3,9})\s+(?P<d>\d{1,2}),?\s+(?P<y>\d{4})"),
]

_DATE_LABEL_RE = re.compile(r"\b(date|dated|invoice\s*date|delivery\s*date)\b", re.I)


def _try_date(m: re.Match) -> date | None:
    try:
        gd = m.groupdict()
        y = int(gd["y"])
        d = int(gd["d"])
        raw_m = gd.get("m") or gd.get("mn", "")
        if raw_m.isdigit():
            mo = int(raw_m)
        else:
            mo = _MONTH_MAP.get(raw_m.lower()[:3])
            if mo is None:
                return None
        return date(y, mo, d)
    except (ValueError, KeyError):
        return None


def extract_date(text_blocks: list[str]) -> str | None:
    """Return the most likely invoice date as ISO "YYYY-MM-DD", or None.

    Prefers blocks that contain a "date:" label; among the rest picks the
    most recent candidate (invoice date tends to be the newest on the slip).
    """
    labelled: list[date] = []
    unlabelled: list[date] = []

    for block in text_blocks:
        has_label = bool(_DATE_LABEL_RE.search(block))
        for pat in _DATE_PATTERNS:
            for m in pat.finditer(block):
                d = _try_date(m)
                if d:
                    (labelled if has_label else unlabelled).append(d)

    candidates = labelled or unlabelled
    return max(candidates).isoformat() if candidates else None


# ---------------------------------------------------------------------------
# Quantity / unit normalisation
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"\d+(?:\.\d+)?")

_PACK_HINTS = frozenset([
    "pck", "pack", "packs", "ctn", "carton", "bag", "bags", "box", "boxes",
    "btl", "bottle", "bottles", "kg", "ltr", "l",
])
_PIECE_HINTS = frozenset(["pc", "pcs", "piece", "pieces", "unit", "units", "nos"])


def _parse_qty(raw: str) -> float | None:
    if not raw:
        return None
    s = raw.strip()
    m = _NUMBER_RE.search(s)
    if not m:
        return None
    try:
        v = float(normalize_number_str(m.group()))
        return v if v > 0 else None
    except ValueError:
        return None


def _parse_unit(raw: str) -> str:
    tokens = set(re.findall(r"[a-z]+", raw.lower()))
    if tokens & _PIECE_HINTS:
        return "PIECE"
    if tokens & _PACK_HINTS:
        return "PACK"
    return "PACK"  # most deliveries are in packs


# ---------------------------------------------------------------------------
# Price parsing
# ---------------------------------------------------------------------------

def _parse_price(raw: str) -> float | None:
    """Parse a price string like '৳1,234.56', '2,00', or '12500' → float.

    Uses normalize_number_str() to handle OCR ambiguity between comma-as-decimal
    (e.g. "2,00" = 2.00) and comma-as-thousands-separator (e.g. "1,234" = 1234).
    """
    if not raw:
        return None
    s = raw.replace("৳", "").replace("BDT", "").replace("Tk", "").replace("tk", "").strip()
    m = _NUMBER_RE.search(s)
    if not m:
        return None
    try:
        v = float(normalize_number_str(m.group()))
        return v if v > 0 else None
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# PP-StructureV3 result → normalised slip dict
# ---------------------------------------------------------------------------

def _collect_text(res) -> list[str]:
    """Pull text strings out of a PP-Structure text-region result.

    Handles the two common shapes:
        - list of {"text": str, "confidence": float, ...}
        - list of [[bbox, (text, confidence)], ...]  (raw PaddleOCR format)
    """
    out: list[str] = []
    if not res:
        return out
    if isinstance(res, str):
        return [res]
    if isinstance(res, dict):
        t = res.get("text") or res.get("txt") or ""
        return [t] if t else []
    for item in res:
        if isinstance(item, dict):
            t = item.get("text") or item.get("txt") or ""
            if t:
                out.append(t)
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            inner = item[1]
            if isinstance(inner, (list, tuple)) and inner:
                out.append(str(inner[0]))
            elif isinstance(inner, str):
                out.append(inner)
    return out


def _typed_item(it: dict) -> dict:
    """Convert one raw table-cell dict (from extract_table_items) to a typed item dict.

    Called when PP-Structure successfully parsed an HTML table (Path A).
    """
    qty          = _parse_qty(it.get("raw_qty", ""))
    rate         = _parse_price(it.get("raw_rate", ""))
    total_amount = _parse_price(it.get("raw_value", ""))
    sd_rate_raw  = it.get("raw_sd_rate", "").replace("%", "").strip()
    sd_rate      = _parse_price(sd_rate_raw) if sd_rate_raw else None
    sd_amount    = _parse_price(it.get("raw_sd_amount", ""))
    vat_rate_raw = it.get("raw_vat_rate", "").replace("%", "").strip()
    vat_rate     = _parse_price(vat_rate_raw) if vat_rate_raw else None
    vat_amount   = _parse_price(it.get("raw_vat", ""))

    # Cross-validate qty via total_amount ÷ rate (catches decimal-drop OCR misreads).
    if qty and rate and total_amount and total_amount > 0:
        if abs(qty * rate - total_amount) / total_amount > 0.05:
            computed = round(total_amount / rate, 2)
            if computed > 0:
                qty = computed

    line_total = _parse_price(it.get("raw_total", "")) or total_amount

    unit_price: float | None = None
    if line_total and qty and qty > 0:
        unit_price = round(line_total / qty, 4)

    return {
        "raw_text":     it["raw_text"],
        "quantity":     qty,
        "unit":         _parse_unit(it.get("raw_unit", "")),
        "unit_price":   unit_price,
        "rate":         rate,
        "total_amount": total_amount,
        "sd_rate":      sd_rate,
        "sd_amount":    sd_amount,
        "vat_rate":     vat_rate,
        "vat_amount":   vat_amount,
        "line_total":   line_total,
    }


def parse_structure_result(structure_result: list[dict]) -> dict:
    """Convert raw PP-StructureV3 output to a normalised slip dict.

    Returns::

        {
            "date":        "YYYY-MM-DD" | None,
            "subtotal":    float | None,
            "vat_total":   float | None,
            "grand_total": float | None,
            "items": [
                {
                    "raw_text":   str,
                    "quantity":   float | None,
                    "unit":       "PACK" | "PIECE",
                    "unit_price": float | None,
                    "line_total": float | None,
                }
            ],
        }
    """
    text_blocks: list[str] = []
    raw_items:   list[dict] = []
    all_rows:    list[list[str]] = []  # every row from every table (for totals)
    # PP-Structure text elements collected for positional fallback parsing.
    # Format: [bbox, (text, confidence)] — same as basic PaddleOCR text output.
    pp_ocr_lines: list = []

    for region in structure_result:
        res = region.get("res", {})

        # Check for HTML table content regardless of the region type label.
        # PP-StructureV3 may label a table region as "figure" instead of "table",
        # but the HTML key in res is the definitive signal that table parsing ran.
        html = ""
        if isinstance(res, dict):
            html = res.get("html", "") or res.get("html_str", "")
        elif isinstance(res, str) and "<table" in res:
            html = res

        if html:
            rows = html_to_rows(html)
            raw_items.extend(extract_table_items(rows))
            all_rows.extend(rows)
            for row in rows:
                text_blocks.extend(row)
        elif isinstance(res, list):
            # PP-Structure returns a list of {text, text_region, confidence}
            # dicts for text/figure regions that it did not parse as a table.
            # Convert each to [bbox, (text, conf)] so parse_text_ocr_lines()
            # can handle them as if they came from the basic text-OCR engine.
            for item in res:
                if not isinstance(item, dict):
                    continue
                text = item.get("text") or item.get("txt") or ""
                bbox = item.get("text_region")
                conf = item.get("confidence", 0.0)
                if text:
                    text_blocks.append(text)
                if text and bbox:
                    pp_ocr_lines.append([bbox, (text, conf)])
        else:
            text_blocks.extend(_collect_text(res))

    date_str    = extract_date(text_blocks)
    slip_totals = extract_slip_totals(all_rows)

    # --- Path A: PP-Structure returned HTML → convert raw table cells to typed items ---
    items: list[dict] = [_typed_item(it) for it in raw_items]

    # --- Path B: PP-Structure returned positional text elements (no HTML table) --------
    # This is the common case for CP Bangladesh invoices where PP-Structure classifies
    # the table region as "figure". We reuse the text elements it already extracted
    # rather than running a second OCR pass.
    if not items and pp_ocr_lines:
        text_parsed = parse_text_ocr_lines(pp_ocr_lines)
        items = text_parsed["items"]
        if not date_str:
            date_str = text_parsed["date"]
        if slip_totals["subtotal"] is None:
            slip_totals["subtotal"] = text_parsed["subtotal"]
        if slip_totals["vat_total"] is None:
            slip_totals["vat_total"] = text_parsed["vat_total"]
        if slip_totals["grand_total"] is None:
            slip_totals["grand_total"] = text_parsed["grand_total"]

    return {
        "date":        date_str,
        "subtotal":    slip_totals["subtotal"],
        "vat_total":   slip_totals["vat_total"],
        "grand_total": slip_totals["grand_total"],
        "items":       items,
    }


# ---------------------------------------------------------------------------
# Text-OCR fallback parser (used when PP-Structure finds no table regions)
# ---------------------------------------------------------------------------

def parse_text_ocr_lines(ocr_lines: list) -> dict:
    """Convert basic PaddleOCR output to a normalised slip dict.

    Input: flat list of [bbox, (text, confidence)] pairs from run_text_ocr().
    Each bbox = [[x0,y0],[x1,y1],[x2,y2],[x3,y3]].

    Strategy:
      1. Build (y_c, x_c, text) tuples for every element.
      2. Group elements into rows by y-centre proximity (±15 px), sort left→right.
      3. Detect header row by keyword overlap (≥2 header keywords).
      4. Map each header cell to a column role (sl / name / qty / unit / rate /
         value / vat / total) using keyword matching.
      5. For each data row assign each cell to the nearest header column by
         x-centre distance.  Column "sl" is discarded; name/qty/unit/rate/total
         are read from their assigned columns.
      6. Fall back to positional heuristics only when no header row is found.
    """
    if not ocr_lines:
        return {"date": None, "subtotal": None, "vat_total": None,
                "grand_total": None, "items": []}

    # Build (y_c, x_c, text) tuples
    positioned: list[tuple[float, float, str]] = []
    for elem in ocr_lines:
        if not elem or len(elem) < 2:
            continue
        bbox, tc = elem[0], elem[1]
        text = tc[0] if isinstance(tc, (list, tuple)) else str(tc)
        text = text.strip()
        if not text:
            continue
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        positioned.append((
            sum(ys) / len(ys),  # y_centre
            sum(xs) / len(xs),  # x_centre
            text,
        ))

    if not positioned:
        return {"date": None, "subtotal": None, "vat_total": None,
                "grand_total": None, "items": []}

    # Group into rows by y proximity (±15 px), sort each row left→right
    positioned.sort(key=lambda p: p[0])
    rows: list[list[tuple[float, float, str]]] = []
    cur: list[tuple[float, float, str]] = [positioned[0]]
    for item in positioned[1:]:
        if abs(item[0] - cur[-1][0]) <= 15:
            cur.append(item)
        else:
            rows.append(sorted(cur, key=lambda p: p[1]))
            cur = [item]
    if cur:
        rows.append(sorted(cur, key=lambda p: p[1]))

    # Flat text for date extraction (all rows including header)
    all_texts = [item[2] for row in rows for item in row]
    date_str  = extract_date(all_texts)

    # ---------------------------------------------------------------------------
    # Column role mapping from header row
    # ---------------------------------------------------------------------------
    _HEADER_KW = frozenset([
        "qty", "quantity", "rate", "price", "total", "name", "product",
        "item", "service", "particulars", "value", "vat", "tax", "unit",
        "sl", "no", "description", "details", "goods",
    ])

    # Maps a cell token set to a column role.
    # Order matters: vat_rate must come before rate so "VAT Rate" is not misidentified.
    # "no" alone is ambiguous (SL vs qty) — resolved by position inside _cell_to_role.
    _COL_ROLES: list[tuple[frozenset, str]] = [
        (frozenset(["sl", "#", "sn"]),                                  "sl"),
        (frozenset(["product", "service", "name", "description",
                    "details", "particulars", "goods", "item"]),        "name"),
        (frozenset(["qty", "quantity"]),                                 "qty"),
        (frozenset(["unit", "uom", "measure"]),                         "unit"),
        (frozenset(["total"]),                                           "total"),  # before value
        (frozenset(["value"]),                                           "value"),
        (frozenset(["vat", "tax"]),                                      "vat"),   # before rate
        (frozenset(["rate", "price"]),                                   "rate"),
    ]

    def _cell_to_role(cell_text: str) -> str | None:
        """Return the role for a single header cell, or None if unrecognised.

        Returns the sentinel "_no_deferred" for cells whose only keyword is "no"
        — those are resolved in a second pass once it's clear whether a "qty"
        column already exists (see below).
        """
        toks = set(re.sub(r"[^a-z0-9]", " ", cell_text.lower()).split())
        _SD = frozenset(["sd", "supplementary"])
        # Combined vat+rate → vat_rate (e.g. "VAT Rate", "Tax %")
        if (toks & frozenset(["vat", "tax"])) and (toks & frozenset(["rate", "price"])):
            return "vat_rate"
        # Combined sd+rate → sd_rate (e.g. "SD Rate", "Supplementary Duty Rate")
        if (toks & _SD) and (toks & frozenset(["rate", "price"])):
            return "sd_rate"
        # Combined sd+amount → sd_amount (e.g. "SD Amount")
        if (toks & _SD) and ("amount" in toks):
            return "sd_amount"
        # "no" alone is ambiguous (could be SL or qty) — defer to two-pass logic
        if "no" in toks and not (toks & frozenset(["product", "service", "name",
                                                    "description", "item"])):
            return "_no_deferred"
        # "Per Unit Price" → rate (check before "unit" alone)
        if (toks & frozenset(["price", "rate"])) and not (toks & frozenset(["vat", "tax", "sd", "supplementary"])):
            for kw_set, role in _COL_ROLES:
                if role == "rate" and toks & kw_set:
                    return role
        # "Total Amount" (pre-tax, no VAT keyword) → "value" role.
        # Everything else → "total" (caller handles last-wins overwrite).
        if "total" in toks:
            if "amount" in toks and not (toks & frozenset(["vat", "tax"])):
                return "value"
            return "total"
        for kw_set, role in _COL_ROLES:
            if toks & kw_set:
                return role
        return None

    def _resolve_no_deferred(
        no_deferred: list[tuple[float, str]],
        col_map: list[tuple[float, str]],
    ) -> None:
        """Resolve ambiguous 'no' header cells and append them to col_map.

        Rules (applied left → right by x-position):
        - If an unambiguous 'qty' column is already in col_map → all 'no' cells = sl.
        - If no qty yet and only ONE 'no' cell → it becomes qty.
        - If no qty yet and MULTIPLE 'no' cells → leftmost = sl, rest = qty.
        """
        has_qty = any(r == "qty" for _, r in col_map)
        for idx, (cx, _) in enumerate(sorted(no_deferred, key=lambda p: p[0])):
            if has_qty:
                col_map.append((cx, "sl"))
            elif len(no_deferred) > 1 and idx == 0:
                col_map.append((cx, "sl"))   # leftmost of multiple → SL
            else:
                col_map.append((cx, "qty"))
                has_qty = True               # subsequent 'no' cells → sl

    # Find header row: ≥2 header-keyword matches in a single row
    header_idx: int | None = None
    col_map: list[tuple[float, str]] = []  # [(x_centre, role), ...]

    for ri, row in enumerate(rows):
        row_text = " ".join(item[2] for item in row)
        toks = set(re.sub(r"[^a-z0-9\s]", "", row_text.lower()).split())
        if len(toks & _HEADER_KW) >= 2:
            header_idx = ri
            # First pass: assign unambiguous roles; defer "no"-only cells
            no_deferred: list[tuple[float, str]] = []
            for cell_y, cell_x, cell_text in row:
                role = _cell_to_role(cell_text)
                if role == "_no_deferred":
                    no_deferred.append((cell_x, cell_text))
                elif role:
                    col_map.append((cell_x, role))
            # Second pass: resolve deferred "no" cells
            _resolve_no_deferred(no_deferred, col_map)
            # If header is one merged cell (e.g. "Sl Name Qty Unit Rate Total"),
            # fall back to positional split: divide evenly
            if not col_map and row:
                row_sorted = sorted(row, key=lambda p: p[1])
                x_min = row_sorted[0][1]
                x_max = row_sorted[-1][1]
                header_tokens = re.sub(r"[^a-z0-9\s]", "", row_text.lower()).split()
                step = (x_max - x_min) / max(len(header_tokens) - 1, 1)
                for ti, tok in enumerate(header_tokens):
                    if tok == "no":
                        continue  # skip ambiguous "no" in merged-header fallback
                    for kw_set, role in _COL_ROLES:
                        if tok in kw_set:
                            col_map.append((x_min + ti * step, role))
                            break
            break

    # Sort col_map left→right
    col_map.sort(key=lambda p: p[0])

    def _assign_role(x: float) -> str | None:
        """Return role for the column whose x_centre is nearest to x."""
        if not col_map:
            return None
        best_role, best_dist = None, float("inf")
        for cx, role in col_map:
            d = abs(cx - x)
            if d < best_dist:
                best_dist, best_role = d, role
        return best_role

    data_rows = rows[header_idx + 1:] if header_idx is not None else rows

    # ---------------------------------------------------------------------------
    # Parse data rows
    # ---------------------------------------------------------------------------
    subtotal = vat_total = grand_total = None
    items: list[dict] = []

    for row in data_rows:
        row_text = " ".join(item[2] for item in row)

        # Skip column-numbering rows (e.g. "1 2 3 4 5 6 7 8 9" second header)
        if row_text.strip() and not any(c.isalpha() for c in row_text):
            continue

        # Summary rows — check before assigning columns
        if _GRAND_TOTAL_RE.search(row_text):
            nums = [v for item in row if (v := _parse_price(item[2])) is not None]
            if nums:
                grand_total = nums[-1]
            continue
        if _SUBTOTAL_RE.search(row_text):
            nums = [v for item in row if (v := _parse_price(item[2])) is not None]
            if nums:
                subtotal = nums[-1]
            continue
        if _VAT_TOTAL_RE.search(row_text) and grand_total is None:
            nums = [v for item in row if (v := _parse_price(item[2])) is not None]
            if nums and vat_total is None:
                vat_total = nums[-1]
            continue
        if _SKIP_NAME_RE.search(row_text):
            continue

        if col_map:
            # Column-position assignment
            assigned: dict[str, list[str]] = {}
            for _yc, xc, text in row:
                role = _assign_role(xc)
                if role and role != "sl":
                    assigned.setdefault(role, []).append(text)

            name_parts = assigned.get("name", [])
            name = " ".join(name_parts).strip() if name_parts else None
            if not name:
                continue

            qty_raw        = " ".join(assigned.get("qty", []))
            unit_raw       = " ".join(assigned.get("unit", []))
            rate_raw       = " ".join(assigned.get("rate", []))
            value_raw      = " ".join(assigned.get("value", []))   # pre-tax subtotal
            sd_rate_raw    = " ".join(assigned.get("sd_rate", []))
            sd_amount_raw  = " ".join(assigned.get("sd_amount", []))
            vat_raw        = " ".join(assigned.get("vat", []))
            vat_rate_raw   = " ".join(assigned.get("vat_rate", []))
            # Prefer "total" col (after-tax); fall back to "value" (pre-tax subtotal)
            total_raw      = (
                " ".join(assigned.get("total", []))
                or value_raw
            )

            qty_val          = _parse_qty(qty_raw) if qty_raw else None
            unit_val         = _parse_unit(unit_raw) if unit_raw else _parse_unit(name)
            rate_val         = _parse_price(rate_raw) if rate_raw else None
            total_amount_val = _parse_price(value_raw) if value_raw else None  # pre-tax
            sd_rate_val      = _parse_price(sd_rate_raw.replace("%", "").strip()) if sd_rate_raw else None
            sd_amount_val    = _parse_price(sd_amount_raw) if sd_amount_raw else None
            vat_amount_val   = _parse_price(vat_raw) if vat_raw else None
            vat_rate_str     = vat_rate_raw.replace("%", "").strip()
            vat_rate_num     = _parse_price(vat_rate_str) if vat_rate_str else None
            line_total_val   = _parse_price(total_raw) if total_raw else None

            # Cross-validate qty via total_amount ÷ rate.
            if qty_val and rate_val and total_amount_val and total_amount_val > 0:
                if abs(qty_val * rate_val - total_amount_val) / total_amount_val > 0.05:
                    computed = round(total_amount_val / rate_val, 2)
                    if computed > 0:
                        qty_val = computed

            # After-tax per-unit price: line_total ÷ qty
            if line_total_val and qty_val and qty_val > 0:
                unit_price_val = round(line_total_val / qty_val, 4)
            else:
                unit_price_val = rate_val  # fallback: pre-tax rate when total unavailable

        else:
            # Fallback: no header detected — use positional heuristics
            # Leftmost alpha-rich cell = name; rightmost numerics = totals
            name = None
            name_x: float | None = None
            for _yc, xc, text in row:
                if any(c.isalpha() for c in text):
                    name = text
                    name_x = xc
                    break
            if not name:
                continue

            numeric_vals: list[float] = []
            qty_candidates: list[float] = []
            for _yc, xc, text in row:
                if name_x is not None and xc <= name_x:
                    continue
                v = _parse_price(text)
                if v is not None:
                    numeric_vals.append(v)
                    if v == int(v) and v <= 999:
                        qty_candidates.append(v)

            line_total_val   = numeric_vals[-1] if numeric_vals else None
            qty_val          = qty_candidates[0] if qty_candidates else None
            unit_val         = _parse_unit(row_text)
            rate_val         = None
            total_amount_val = None
            sd_rate_val      = None
            sd_amount_val    = None
            vat_rate_num     = None
            vat_amount_val   = None
            # After-tax per-unit from heuristic numbers
            if line_total_val and qty_val and qty_val > 0:
                unit_price_val = round(line_total_val / qty_val, 4)
            else:
                unit_price_val = numeric_vals[-2] if len(numeric_vals) >= 2 else None

        items.append({
            "raw_text":     name,
            "quantity":     qty_val,
            "unit":         unit_val,
            "unit_price":   unit_price_val,   # after-tax per unit (line_total ÷ qty)
            "rate":         rate_val,          # pre-tax per unit price
            "total_amount": total_amount_val,  # pre-tax subtotal (qty × rate)
            "sd_rate":      sd_rate_val,       # Supplementary Duty %
            "sd_amount":    sd_amount_val,     # Supplementary Duty amount
            "vat_rate":     vat_rate_num,      # VAT %
            "vat_amount":   vat_amount_val,    # VAT amount
            "line_total":   line_total_val,    # after-tax total
        })

    return {
        "date":        date_str,
        "subtotal":    subtotal,
        "vat_total":   vat_total,
        "grand_total": grand_total,
        "items":       items,
    }
