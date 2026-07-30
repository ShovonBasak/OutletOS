"""InvoiceParser: converts raw OCR output into a structured intermediate dict.

Two-pass strategy (no external API):
  Pass 1 — PP-StructureV3: detects table layout + OCR (best for bordered tables).
  Pass 2 — Basic text OCR: column-position assignment (for borderless invoices).

The parser returns a plain dict (not yet the final schema) so that the caller
can apply matching and validation before constructing InvoiceOCRResult.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Optional

from .constants import (
    ALL_HEADER_KW,
    COL_ROLE_MAP,
    CP_SUPPLIER_RE,
    CUSTOMER_LABEL_RE,
    GRAND_TOTAL_RE,
    INVOICE_NO_RE,
    NAME_KW,
    QTY_KW,
    RATE_KW,
    SD_KW,
    SKIP_ROW_RE,
    SUBTOTAL_RE,
    SUPPLIER_LABEL_RE,
    TOTAL_KW,
    UNIT_KW,
    VALUE_KW,
    VAT_KW,
    VAT_TOTAL_RE,
)
from .utils import cell_tokens, extract_date, normalize_number


# ---------------------------------------------------------------------------
# HTML table parser (for PP-Structure "table" regions)
# ---------------------------------------------------------------------------


class _HTMLTableParser(HTMLParser):
    """Minimal HTML table parser — treats thead/tbody as transparent wrappers."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] = []
        self._cell: list[str] = []
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
            self._in_cell = True
        elif tag == "br" and self._in_cell:
            self._cell.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th"):
            # Join parts with a space so multi-line cell content stays readable
            self._row.append(" ".join(p for p in self._cell if p.strip()).strip())
            self._in_cell = False
        elif tag == "tr" and self._row:
            self.rows.append(self._row[:])
            self._row = []

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell.append(data)


def _html_to_rows(html: str) -> list[list[str]]:
    p = _HTMLTableParser()
    p.feed(html)
    return p.rows


# ---------------------------------------------------------------------------
# Column detection helpers (shared by both passes)
# ---------------------------------------------------------------------------


def _detect_columns(header_row: list[str]) -> dict[str, int]:
    """Map column roles to their index in the header row.

    Two-pass "no" resolution (same logic as table_parser._detect_columns):
    • Combined vat+rate → "vat_rate" checked first.
    • Unambiguous SL markers (sl, #, sn) → "sl" immediately.
    • "no"-only cells deferred; resolved after all other columns are known:
        – has unambiguous qty → all deferred = sl
        – single deferred, no qty → deferred = qty
        – multiple deferred, no qty → leftmost = sl, rest = qty
    """
    col: dict[str, int] = {}
    no_deferred: list[int] = []

    for i, cell in enumerate(header_row):
        toks = cell_tokens(cell)

        # Combined vat+rate → vat_rate (e.g. "VAT Rate", "Tax %")
        if (toks & VAT_KW) and (toks & RATE_KW):
            col.setdefault("vat_rate", i)
            continue

        # Combined sd+rate → sd_rate (e.g. "SD Rate", "Supplementary Duty Rate")
        if (toks & SD_KW) and (toks & RATE_KW):
            col.setdefault("sd_rate", i)
            continue

        # Combined sd+amount → sd_amount (e.g. "SD Amount")
        if (toks & SD_KW) and ("amount" in toks):
            col.setdefault("sd_amount", i)
            continue

        # Unambiguous SL markers
        if (toks & frozenset(["sl", "#", "sn"])) and not (toks & NAME_KW):
            col.setdefault("sl", i)
            continue

        # "no" without any other disambiguating keyword → defer
        if "no" in toks and not (toks & (NAME_KW | QTY_KW)):
            no_deferred.append(i)
            continue

        if toks & NAME_KW:
            col.setdefault("name", i)
        elif toks & QTY_KW:
            col.setdefault("qty", i)
        elif toks & RATE_KW:
            # Check RATE before UNIT so "Per Unit Price" → "rate" (not "unit")
            col.setdefault("rate", i)
        elif toks & UNIT_KW:
            col.setdefault("unit", i)
        elif toks & TOTAL_KW:
            # "Total Amount" (pre-tax, no VAT keyword) → "value" role.
            # Anything else → "total" with overwrite so the rightmost column wins
            # and "Total Amount" never blocks "Total Value incl. VAT & Tax".
            if "amount" in toks and not (toks & VAT_KW):
                col.setdefault("value", i)
            else:
                col["total"] = i             # overwrite → last/rightmost "total" wins
        elif toks & VALUE_KW:
            col.setdefault("value", i)
        elif toks & VAT_KW:
            col.setdefault("vat", i)

    # Resolve deferred "no" cells
    has_qty = "qty" in col
    for seq, i in enumerate(no_deferred):
        if has_qty:
            col.setdefault("sl", i)
        elif len(no_deferred) > 1 and seq == 0:
            col.setdefault("sl", i)
        else:
            col.setdefault("qty", i)
            has_qty = True

    return col


def _is_header_row(row: list[str]) -> bool:
    all_toks: set[str] = set()
    for cell in row:
        all_toks |= cell_tokens(cell)
    return len(all_toks & ALL_HEADER_KW) >= 2


def _rightmost_number(row: list[str]) -> Optional[float]:
    for cell in reversed(row):
        v = normalize_number(cell)
        if v is not None:
            return v
    return None


# ---------------------------------------------------------------------------
# Table rows → raw item dicts
# ---------------------------------------------------------------------------


def _rows_to_items(rows: list[list[str]]) -> list[dict]:
    """Extract item dicts from a list of table rows.

    Looks for the first header row, maps column roles, then reads data rows.
    """
    header_idx: Optional[int] = None
    col: dict[str, int] = {}

    for i, row in enumerate(rows):
        cm = _detect_columns(row)
        if "name" in cm:
            header_idx = i
            col = cm
            break

    if header_idx is None or "name" not in col:
        return []

    items: list[dict] = []
    for row in rows[header_idx + 1 :]:
        if not row:
            continue
        # Skip column-numbering rows (e.g. "1 | 2 | 3 | 4 | …" second header)
        if all(not any(c.isalpha() for c in cell) for cell in row if cell.strip()):
            continue

        def _cell(role: str) -> str:
            idx = col.get(role)
            return row[idx].strip() if idx is not None and idx < len(row) else ""

        name = _cell("name")
        if not name or not any(c.isalpha() for c in name):
            continue
        if SKIP_ROW_RE.search(name):
            continue

        qty          = normalize_number(_cell("qty"))
        rate         = normalize_number(_cell("rate"))
        total_amount = normalize_number(_cell("value"))   # pre-tax subtotal
        sd_rate_str  = _cell("sd_rate").replace("%", "").strip()
        vat_rate_str = _cell("vat_rate").replace("%", "").strip()
        line_total   = normalize_number(_cell("total")) or total_amount

        # Cross-validate qty via total_amount ÷ rate.
        # OCR sometimes drops a decimal point ("2.00" → "200"); if qty × rate
        # diverges from total_amount by >5%, the back-computed value is more
        # trustworthy than the raw OCR read.
        if qty and rate and total_amount and total_amount > 0:
            if abs(qty * rate - total_amount) / total_amount > 0.05:
                computed = round(total_amount / rate, 2)
                if computed > 0:
                    qty = computed

        # After-tax per-unit price: line_total ÷ qty
        if line_total and qty and qty > 0:
            unit_price: float | None = round(line_total / qty, 4)
        else:
            unit_price = rate  # fallback when total unavailable

        items.append({
            "product_name": name,
            "quantity":     qty,
            "unit":         _cell("unit") or "PACK",
            "unit_price":   unit_price,                                    # after-tax per unit
            "rate":         rate,                                          # pre-tax rate
            "amount":       total_amount,                                  # pre-tax subtotal
            "sd_rate":      normalize_number(sd_rate_str) if sd_rate_str else None,
            "sd_amount":    normalize_number(_cell("sd_amount")),
            "vat":          normalize_number(_cell("vat")),
            "vat_rate":     normalize_number(vat_rate_str) if vat_rate_str else None,
            "total":        line_total,
        })

    return items


# ---------------------------------------------------------------------------
# Collect slip-level totals from all rows
# ---------------------------------------------------------------------------


def _extract_slip_totals(all_rows: list[list[str]]) -> dict:
    subtotal = vat = grand_total = None
    for row in all_rows:
        text = " ".join(row)
        if GRAND_TOTAL_RE.search(text):
            grand_total = _rightmost_number(row) or grand_total
        elif SUBTOTAL_RE.search(text):
            subtotal = _rightmost_number(row) or subtotal
        elif VAT_TOTAL_RE.search(text) and grand_total is None:
            vat = vat or _rightmost_number(row)
    return {"subtotal": subtotal, "vat": vat, "grand_total": grand_total}


# ---------------------------------------------------------------------------
# Header-field extraction from plain text blocks
# ---------------------------------------------------------------------------


def _extract_header_fields(text_blocks: list[str]) -> dict:
    """Pull invoice number, supplier, and customer from text blocks."""
    invoice_number = supplier = customer = ""

    for block in text_blocks:
        if not invoice_number:
            m = INVOICE_NO_RE.search(block)
            if m:
                invoice_number = m.group(1).strip()

        if not supplier:
            if CP_SUPPLIER_RE.search(block):
                supplier = CP_SUPPLIER_RE.search(block).group(0).strip()
            else:
                m = SUPPLIER_LABEL_RE.search(block)
                if m:
                    supplier = m.group(2).strip()

        if not customer:
            m = CUSTOMER_LABEL_RE.search(block)
            if m:
                customer = m.group(2).strip()

    return {
        "invoice_number": invoice_number,
        "supplier": supplier,
        "customer": customer,
    }


# ---------------------------------------------------------------------------
# PP-Structure text-region flattener
# ---------------------------------------------------------------------------


def _collect_text_from_region(res: object) -> list[str]:
    """Extract text strings from a PP-Structure text-region result."""
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


# ---------------------------------------------------------------------------
# Text-OCR positional parser (Pass 2 fallback)
# ---------------------------------------------------------------------------


def _parse_text_ocr(ocr_lines: list) -> tuple[list[dict], list[list[str]]]:
    """Parse raw PaddleOCR output into item dicts and summary rows.

    Uses header-row x-coordinates to assign each data cell to the correct column.
    Returns (items, summary_rows).
    """
    if not ocr_lines:
        return [], []

    # Build (y_c, x_c, text) elements
    elems: list[tuple[float, float, str]] = []
    for elem in ocr_lines:
        if not elem or len(elem) < 2:
            continue
        bbox, tc = elem[0], elem[1]
        text = (tc[0] if isinstance(tc, (list, tuple)) else str(tc)).strip()
        if not text:
            continue
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        elems.append((sum(ys) / 4, sum(xs) / 4, text))

    if not elems:
        return [], []

    # Group into rows by y proximity (±15 px)
    elems.sort(key=lambda e: e[0])
    row_groups: list[list[tuple[float, float, str]]] = []
    cur = [elems[0]]
    for e in elems[1:]:
        if abs(e[0] - cur[-1][0]) <= 15:
            cur.append(e)
        else:
            row_groups.append(sorted(cur, key=lambda e: e[1]))
            cur = [e]
    row_groups.append(sorted(cur, key=lambda e: e[1]))

    # Detect header row and build column map: [(x_centre, role), ...]
    header_idx: Optional[int] = None
    col_map: list[tuple[float, str]] = []

    for ri, row in enumerate(row_groups):
        toks: set[str] = set()
        for _, _, t in row:
            toks |= cell_tokens(t)
        if len(toks & ALL_HEADER_KW) >= 2:
            header_idx = ri
            # First pass: unambiguous roles; defer "no"-only cells
            no_deferred_pos: list[float] = []  # x-centres of deferred "no" cells
            for _, xc, text in row:
                clean = cell_tokens(text)
                # Combined vat+rate → vat_rate
                if (clean & VAT_KW) and (clean & RATE_KW):
                    col_map.append((xc, "vat_rate"))
                    continue
                # Unambiguous SL markers
                if (clean & frozenset(["sl", "#", "sn"])) and not (clean & NAME_KW):
                    col_map.append((xc, "sl"))
                    continue
                # "no" without other disambiguating keywords → defer
                if "no" in clean and not (clean & (NAME_KW | QTY_KW)):
                    no_deferred_pos.append(xc)
                    continue
                for kw_set, role in COL_ROLE_MAP:
                    if clean & kw_set:
                        col_map.append((xc, role))
                        break
            # Second pass: resolve deferred "no" cells
            has_qty = any(r == "qty" for _, r in col_map)
            for seq, xc in enumerate(sorted(no_deferred_pos)):
                if has_qty:
                    col_map.append((xc, "sl"))
                elif len(no_deferred_pos) > 1 and seq == 0:
                    col_map.append((xc, "sl"))
                else:
                    col_map.append((xc, "qty"))
                    has_qty = True
            col_map.sort(key=lambda p: p[0])
            break

    def _nearest_role(x: float) -> Optional[str]:
        if not col_map:
            return None
        return min(col_map, key=lambda p: abs(p[0] - x))[1]

    data_rows = row_groups[header_idx + 1 :] if header_idx is not None else row_groups

    items: list[dict] = []
    summary_rows: list[list[str]] = []

    for row in data_rows:
        row_text = " ".join(t for _, _, t in row)

        # Skip column-numbering rows (e.g. "1 2 3 4 5 6 7 8 9" second header)
        if row_text.strip() and not any(c.isalpha() for c in row_text):
            continue

        # Summary rows
        if GRAND_TOTAL_RE.search(row_text) or SUBTOTAL_RE.search(row_text) or \
                VAT_TOTAL_RE.search(row_text):
            summary_rows.append([t for _, _, t in row])
            continue

        if col_map:
            assigned: dict[str, list[str]] = {}
            for _, xc, text in row:
                role = _nearest_role(xc)
                if role and role != "sl":
                    assigned.setdefault(role, []).append(text)

            name_parts = assigned.get("name", [])
            name = " ".join(name_parts).strip()

            # If this row has ONLY name-column content and we already have an item
            # whose numeric fields are still None, this is a continuation line of
            # the previous cell (e.g. a product name that wraps across 2–3 lines).
            numeric_roles = {k for k in assigned if k not in ("name", "sl")}
            if items and not numeric_roles and name and any(c.isalpha() for c in name):
                prev = items[-1]
                if prev["quantity"] is None and prev["rate"] is None:
                    prev["product_name"] = prev["product_name"] + " " + name
                    continue

            if not name or not any(c.isalpha() for c in name):
                continue
            if SKIP_ROW_RE.search(name):
                continue

            qty_raw       = " ".join(assigned.get("qty", []))
            unit_raw      = " ".join(assigned.get("unit", []))
            rate_raw      = " ".join(assigned.get("rate", []))
            value_raw     = " ".join(assigned.get("value", []))
            sd_rate_raw   = " ".join(assigned.get("sd_rate", []))
            sd_amount_raw = " ".join(assigned.get("sd_amount", []))
            vat_raw       = " ".join(assigned.get("vat", []))
            vat_rate_raw  = " ".join(assigned.get("vat_rate", []))
            total_raw     = (
                " ".join(assigned.get("total", []))
                or value_raw
            )

            qty          = normalize_number(qty_raw)
            rate         = normalize_number(rate_raw)
            total_amount = normalize_number(value_raw)   # pre-tax subtotal
            line_total   = normalize_number(total_raw)
            sd_rate_str  = sd_rate_raw.replace("%", "").strip()
            vat_rate_str = vat_rate_raw.replace("%", "").strip()
            # After-tax per-unit price: line_total ÷ qty
            if line_total and qty and qty > 0:
                unit_price: Optional[float] = round(line_total / qty, 4)
            else:
                unit_price = rate  # fallback when total unavailable

            items.append({
                "product_name": name,
                "quantity":     qty,
                "unit":         unit_raw.strip() or "PACK",
                "unit_price":   unit_price,                                    # after-tax per unit
                "rate":         rate,                                          # pre-tax rate
                "amount":       total_amount,                                  # pre-tax subtotal
                "sd_rate":      normalize_number(sd_rate_str) if sd_rate_str else None,
                "sd_amount":    normalize_number(sd_amount_raw),
                "vat":          normalize_number(vat_raw),
                "vat_rate":     normalize_number(vat_rate_str) if vat_rate_str else None,
                "total":        line_total,
            })
        else:
            # No header — heuristic fallback
            name: Optional[str] = None
            name_x: Optional[float] = None
            for _, xc, text in row:
                if any(c.isalpha() for c in text):
                    if not SKIP_ROW_RE.search(text):
                        name = text
                        name_x = xc
                        break
            if not name:
                continue

            nums: list[float] = []
            for _, xc, text in row:
                if name_x is not None and xc <= name_x:
                    continue
                v = normalize_number(text)
                if v is not None:
                    nums.append(v)

            line_total = nums[-1] if nums else None
            qty_fb: Optional[float] = None  # can't reliably detect qty without header
            # After-tax per-unit from heuristic numbers when qty available
            if line_total and qty_fb and qty_fb > 0:
                unit_price_fb: Optional[float] = round(line_total / qty_fb, 4)
            else:
                unit_price_fb = nums[-2] if len(nums) >= 2 else None

            items.append({
                "product_name": name,
                "quantity":     qty_fb,
                "unit":         "PACK",
                "unit_price":   unit_price_fb,
                "rate":         None,
                "amount":       None,
                "vat":          None,
                "vat_rate":     None,
                "total":        line_total,
            })

    return items, summary_rows


# ---------------------------------------------------------------------------
# Public parser class
# ---------------------------------------------------------------------------


class InvoiceParser:
    """Stateless parser: converts raw OCR output to an intermediate dict.

    The returned dict has the shape::

        {
            "invoice_number": str,
            "invoice_date":   str,     # "YYYY-MM-DD" or ""
            "supplier":       str,
            "customer":       str,
            "items":          list[dict],
            "summary":        dict,    # subtotal / vat / grand_total
        }

    Each item dict::

        {
            "product_name": str,
            "quantity":     float | None,
            "unit":         str,
            "unit_price":   float | None,
            "amount":       float | None,
            "vat":          float | None,
            "total":        float | None,
        }
    """

    def parse(
        self,
        layout_result: list[dict],
        text_result: list,
        image_shape: tuple[int, int, int],
    ) -> dict:
        """Parse PP-Structure + text-OCR output into a structured dict.

        Args:
            layout_result: Output of OCRService.run_layout().
            text_result:   Output of OCRService.run_text().
            image_shape:   (height, width, channels) of the preprocessed image.

        Returns:
            Intermediate dict (see class docstring).
        """
        text_blocks: list[str] = []
        all_table_rows: list[list[str]] = []
        items: list[dict] = []

        # --- Pass 1: PP-Structure ---
        for region in layout_result:
            rtype = (region.get("type") or "").lower().replace(" ", "_")
            res = region.get("res", {})

            if "table" in rtype:
                html = ""
                if isinstance(res, dict):
                    html = res.get("html", "") or res.get("html_str", "")
                elif isinstance(res, str):
                    html = res
                if html:
                    rows = _html_to_rows(html)
                    all_table_rows.extend(rows)
                    items.extend(_rows_to_items(rows))
                    # Mine table cells for date/header candidates
                    for row in rows:
                        text_blocks.extend(row)

            elif rtype in ("text", "title", "plain_text", "header",
                           "figure_caption", "reference"):
                text_blocks.extend(_collect_text_from_region(res))

        # --- Pass 2: Text OCR fallback when PP-Structure found no items ---
        if not items and text_result:
            text_items, summary_rows = _parse_text_ocr(text_result)
            items = text_items
            all_table_rows.extend(summary_rows)
            # Text lines also feed date/header extraction
            for elem in text_result:
                if elem and len(elem) >= 2:
                    tc = elem[1]
                    t = (tc[0] if isinstance(tc, (list, tuple)) else str(tc)).strip()
                    if t:
                        text_blocks.append(t)

        # --- Header fields ---
        invoice_date = extract_date(text_blocks)
        header = _extract_header_fields(text_blocks)
        summary = _extract_slip_totals(all_table_rows)

        return {
            "invoice_number": header["invoice_number"],
            "invoice_date":   invoice_date,
            "supplier":       header["supplier"],
            "customer":       header["customer"],
            "items":          items,
            "summary":        summary,
        }
