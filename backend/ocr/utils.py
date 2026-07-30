"""Shared utilities: number normalisation and date extraction."""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

from .constants import DATE_LABEL_RE, DATE_PATTERNS, MONTH_MAP, NUMBER_RE


# ---------------------------------------------------------------------------
# Number normalisation
# ---------------------------------------------------------------------------

_CURRENCY_RE = re.compile(r"[৳BDTkKtT\s]+")


def normalize_number(raw: str) -> Optional[float]:
    """Convert an OCR number string to a Python float, handling common OCR errors.

    Handles:
        "2,00"      → 2.00   (OCR misread decimal point as comma)
        "1,234"     → 1234   (thousands separator)
        "1,234.56"  → 1234.56
        "1.234,56"  → 1234.56 (European decimal format)
        "৳ 1,500"  → 1500.0
        "200"       → 200.0
        "2.00"      → 2.00

    Returns None for empty, zero, or non-numeric strings.
    """
    if not raw:
        return None

    # Strip currency symbols
    s = _CURRENCY_RE.sub("", raw).strip()
    m = NUMBER_RE.search(s)
    if not m:
        return None

    token = m.group()
    dot_pos = token.rfind(".")
    comma_pos = token.rfind(",")

    if dot_pos == -1 and comma_pos == -1:
        # Plain integer
        normalized = token
    elif dot_pos > comma_pos:
        # Dot is the rightmost separator → decimal point: "1,234.56"
        normalized = token.replace(",", "")
    else:
        # Comma is the rightmost separator
        if dot_pos == -1:
            # Only commas present
            after_comma = token[comma_pos + 1 :]
            if len(after_comma) <= 2:
                # "2,00" or "1,5" → comma is decimal
                normalized = token[:comma_pos] + "." + after_comma
            else:
                # "1,234" → comma is thousands separator
                normalized = token.replace(",", "")
        else:
            # dot before comma → European format: "1.234,56"
            normalized = token.replace(".", "").replace(",", ".")

    try:
        v = float(normalized)
        return v if v > 0 else None
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Date extraction
# ---------------------------------------------------------------------------


def _try_date(m: re.Match) -> Optional[date]:
    """Attempt to build a date from a regex match with named groups."""
    try:
        gd = m.groupdict()
        y = int(gd["y"])
        d_val = int(gd["d"])
        raw_m: str = gd.get("m") or gd.get("mn", "")
        if str(raw_m).isdigit():
            mo = int(raw_m)
        else:
            mo = MONTH_MAP.get(str(raw_m).lower()[:3])
            if mo is None:
                return None
        return date(y, mo, d_val)
    except (ValueError, KeyError):
        return None


def extract_date(text_blocks: list[str]) -> str:
    """Return the most likely invoice date as ISO "YYYY-MM-DD", or empty string.

    Prefers blocks that contain a date-label keyword ("date:", "invoice date:", etc.).
    Among multiple candidates, picks the most recent (invoice dates tend to be newest).
    """
    labelled: list[date] = []
    unlabelled: list[date] = []

    for block in text_blocks:
        has_label = bool(DATE_LABEL_RE.search(block))
        for pat in DATE_PATTERNS:
            for m in pat.finditer(block):
                d = _try_date(m)
                if d:
                    (labelled if has_label else unlabelled).append(d)

    candidates = labelled or unlabelled
    return max(candidates).isoformat() if candidates else ""


# ---------------------------------------------------------------------------
# Cell tokenisation helper
# ---------------------------------------------------------------------------


def cell_tokens(text: str) -> set[str]:
    """Lowercase alphanumeric tokens from a cell string."""
    return set(re.sub(r"[^a-z0-9\s]", "", text.lower()).split())
