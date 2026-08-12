"""Parse Foodpanda order export XLSX files without openpyxl (avoids stylesheet compat issues)."""

import re
import zipfile
from collections import defaultdict
from datetime import date
from xml.etree import ElementTree as ET


_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _col_letters(ref: str) -> str:
    """'AX3' → 'AX'"""
    return re.sub(r"\d", "", ref)


def _cell_value(c_el) -> str | None:
    is_el = c_el.find(f"{{{_NS}}}is")
    if is_el is not None:
        t_el = is_el.find(f"{{{_NS}}}t")
        return (t_el.text or "").strip() if t_el is not None else ""
    v_el = c_el.find(f"{{{_NS}}}v")
    return v_el.text if v_el is not None else None


def _parse_sheet(file_obj) -> list[dict[str, str | None]]:
    """Return list of dicts keyed by column letter (e.g. 'AX')."""
    with zipfile.ZipFile(file_obj) as z:
        with z.open("xl/worksheets/sheet1.xml") as f:
            root = ET.parse(f).getroot()

    rows = []
    for row_el in root.iter(f"{{{_NS}}}row"):
        row: dict[str, str | None] = {}
        for c_el in row_el.iter(f"{{{_NS}}}c"):
            ref = c_el.attrib.get("r", "")
            col = _col_letters(ref)
            row[col] = _cell_value(c_el)
        rows.append(row)
    return rows


def _find_header_row(rows: list[dict]) -> tuple[int, dict[str, str]]:
    """Return (header_row_index, {column_letter: header_name}) for the row containing 'Order status'."""
    for i, row in enumerate(rows):
        for col, val in row.items():
            if val and "order status" in val.lower():
                return i, {col: v for col, v in row.items() if v}
    raise ValueError("Could not find header row in the uploaded file.")


def _parse_order_items(text: str) -> list[tuple[int, str]]:
    """'2 Lollipop Bologna, 1 Karaage Chicken' → [(2, 'Lollipop Bologna'), (1, 'Karaage Chicken')]"""
    result = []
    for part in text.split(","):
        part = part.strip()
        m = re.match(r"^(\d+)\s+(.+)$", part)
        if m:
            result.append((int(m.group(1)), m.group(2).strip()))
    return result


def _extract_date(value: str | None) -> date | None:
    """Extract date from 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DD'."""
    if not value:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2})", value)
    if m:
        from datetime import datetime
        return datetime.strptime(m.group(1), "%Y-%m-%d").date()
    return None


def parse_foodpanda_excel(
    file_obj,
    closing_date: date,
    channel,
) -> tuple[list[dict], list[dict]]:
    """Parse a Foodpanda order report XLSX.

    Returns:
        mapped   — [{"product": Product, "quantity": int}, ...]
        unresolved — [{"external_name": str, "order_qty": int}, ...] (deduplicated, aggregated)
    """
    from sales.models import ChannelMenuMap

    rows = _parse_sheet(file_obj)
    header_idx, header_map = _find_header_row(rows)

    # Build reverse map: column_letter → header_name (lowercase)
    col_by_header: dict[str, str] = {v.lower(): k for k, v in header_map.items()}

    status_col = col_by_header.get("order status")
    delivered_col = col_by_header.get("delivered at")
    items_col = col_by_header.get("order items")

    if not status_col or not items_col:
        raise ValueError("Required columns 'Order status' or 'Order Items' not found in file.")

    # Load all active mappings for this channel
    maps = {
        m.external_name.lower(): m
        for m in ChannelMenuMap.objects.filter(channel=channel, is_active=True).select_related("product")
    }

    product_qty: dict[int, int] = defaultdict(int)  # product_id → total qty
    unresolved_qty: dict[str, int] = defaultdict(int)  # external_name → total qty

    data_rows = rows[header_idx + 1:]
    for row in data_rows:
        status = row.get(status_col, "") or ""
        if status.strip().lower() != "delivered":
            continue

        if delivered_col:
            delivery_date = _extract_date(row.get(delivered_col))
            if delivery_date != closing_date:
                continue

        items_text = row.get(items_col, "") or ""
        for order_qty, name in _parse_order_items(items_text):
            mapping = maps.get(name.lower())
            if mapping:
                product_qty[mapping.product_id] += order_qty * mapping.quantity_multiplier
            else:
                unresolved_qty[name] += order_qty

    # Resolve product objects
    from catalog.models import Product as ProductModel
    product_map = {
        p.id: p for p in ProductModel.objects.filter(id__in=product_qty.keys())
    }

    mapped = [
        {"product": product_map[pid], "quantity": qty}
        for pid, qty in product_qty.items()
        if pid in product_map
    ]
    unresolved = [
        {"external_name": name, "order_qty": qty}
        for name, qty in sorted(unresolved_qty.items())
    ]

    return mapped, unresolved
