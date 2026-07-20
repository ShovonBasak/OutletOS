"""Slip OCR extraction for Stock In.

Reads an uploaded delivery-slip image and produces candidate line items
(SLIP_EXTRACTED). Each OCR line is matched against SupplierProductAlias (exact,
then normalized/fuzzy) to resolve an Ingredient and its active PackDefinition.
Unmatched lines are kept as "Unrecognized" rows (ingredient_id=None) so staff
can resolve them once — that resolution saves a new alias for next time.

This is deliberately best-effort: the raw parsed value is stored in
`extracted_quantity` for audit, and staff must confirm/correct
`confirmed_quantity` before submitting. It never fabricates data — if OCR is
unavailable it raises OcrUnavailable so the UI can fall back to manual entry.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from catalog.models import SupplierProductAlias


class OcrUnavailable(Exception):
    """Tesseract/pytesseract not installed, or the image can't be read."""


@dataclass
class ExtractedLine:
    raw_text: str
    extracted_quantity: float | None
    ingredient_id: int | None = None
    pack_definition_id: int | None = None
    unit_captured: str = "PACK"


def _ocr_text(image_path: str) -> str:
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover
        raise OcrUnavailable("pytesseract/Pillow not installed") from exc

    # Normalize before OCR: phone photos arrive as MPO/HEIC and often carry EXIF
    # rotation. tesseract only accepts plain formats, so honor orientation and
    # flatten to RGB (this drops the MPO multi-frame container iPhones produce).
    try:
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
    except Exception as exc:  # unreadable/corrupt/unsupported image
        raise OcrUnavailable(f"cannot read image: {exc}") from exc

    try:
        return pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError as exc:
        raise OcrUnavailable("tesseract binary not installed") from exc


def _normalize(text: str) -> str:
    """Lower-case, strip punctuation, collapse whitespace — for fuzzy alias
    matching that survives common supplier abbreviation/spacing differences."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _build_alias_index():
    """Map normalized alias text → (ingredient_id, active pack_definition_id)."""
    index = []
    aliases = SupplierProductAlias.objects.filter(is_active=True).select_related(
        "ingredient"
    )
    for alias in aliases:
        pack = alias.ingredient.pack_definitions.filter(effective_to__isnull=True).first()
        index.append(
            (
                _normalize(alias.alias_text),
                alias.ingredient_id,
                pack.id if pack else None,
            )
        )
    return index


def _match(norm_line: str, index):
    """Exact normalized match first, then substring/token overlap fallback."""
    for norm_alias, ingredient_id, pack_id in index:
        if norm_alias and norm_alias == norm_line:
            return ingredient_id, pack_id
    best, best_score = None, 0.0
    line_tokens = set(norm_line.split())
    for norm_alias, ingredient_id, pack_id in index:
        alias_tokens = set(norm_alias.split())
        if not alias_tokens:
            continue
        if norm_alias in norm_line or norm_line in norm_alias:
            return ingredient_id, pack_id
        overlap = len(line_tokens & alias_tokens) / len(alias_tokens)
        if overlap > best_score:
            best_score, best = overlap, (ingredient_id, pack_id)
    return best if best_score >= 0.6 else None


def parse_lines(text: str) -> list[ExtractedLine]:
    """Turn OCR text into candidate StockInItem rows. Lines that match an alias
    resolve to an ingredient; the rest are kept raw as Unrecognized rows."""
    index = _build_alias_index()
    results: list[ExtractedLine] = []

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        norm = _normalize(stripped)
        if not norm or not re.search(r"[a-z]", norm):
            continue  # pure separators / page numbers

        # First standalone number on the line is taken as the quantity (packs).
        numbers = re.findall(r"(?<![\w.])\d+(?:\.\d+)?(?!\w)", stripped)
        qty = float(numbers[0]) if numbers else None

        matched = _match(norm, index)
        if matched:
            ingredient_id, pack_id = matched
            results.append(
                ExtractedLine(
                    raw_text=stripped,
                    extracted_quantity=qty,
                    ingredient_id=ingredient_id,
                    pack_definition_id=pack_id,
                    unit_captured="PACK",
                )
            )
        else:
            results.append(
                ExtractedLine(
                    raw_text=stripped,
                    extracted_quantity=qty,
                    ingredient_id=None,
                    pack_definition_id=None,
                    unit_captured="PACK",
                )
            )

    return results


def extract_from_slip(image_path: str) -> list[ExtractedLine]:
    text = _ocr_text(image_path)
    return parse_lines(text)


# ---------------------------------------------------------------------------
# Setup-time bulk extraction: pull unique NEW ingredients from many slips.
# Used by the owner "Extract ingredients" screen (not per-line stock-in).
# ---------------------------------------------------------------------------

# Words that mark a slip line as bookkeeping, not a real ingredient.
NON_INGREDIENT_HINTS = {
    "delivery", "charge", "charges", "vat", "tax", "total", "subtotal",
    "discount", "bill", "invoice", "date", "qty", "quantity", "amount",
    "price", "taka", "tk", "phone", "mobile", "address", "balance", "paid",
    "due", "gst", "service", "grand", "payable", "cash", "change",
}

# Trailing pack/size tokens to drop when suggesting a clean internal name.
_PACK_TOKEN_RE = re.compile(
    r"\b\d+\s*(pc|pcs|pieces|ltr|l|ml|oz|kg|gm|gms|g|btl|bottle|bag|pkt|packet|pack|box|ctn|carton)\b",
    re.I,
)
# Pack yield embedded in the item name, e.g. "10PC" → 10 pieces per pack.
_PACK_PIECES_RE = re.compile(r"(\d+)\s*(?:pc|pcs|pieces)\b", re.I)


def ocr_text_from_fileobj(fileobj) -> str:
    """OCR an in-memory uploaded image (no need to persist it to disk)."""
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover
        raise OcrUnavailable("pytesseract/Pillow not installed") from exc
    try:
        fileobj.seek(0)
        img = Image.open(fileobj)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
    except Exception as exc:
        raise OcrUnavailable(f"cannot read image: {exc}") from exc
    try:
        return pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError as exc:
        raise OcrUnavailable("tesseract binary not installed") from exc


def _looks_like_non_ingredient(norm: str) -> bool:
    return bool(set(norm.split()) & NON_INGREDIENT_HINTS)


def suggest_name(raw: str) -> str:
    """Turn a raw slip line into a clean candidate internal name."""
    s = _PACK_TOKEN_RE.sub("", raw)
    s = re.sub(r"[^A-Za-z0-9 ]+", " ", s)
    s = re.sub(r"\b\d+\b", "", s)          # drop stray standalone numbers
    s = re.sub(r"\s+", " ", s).strip()
    return s.title() if s else raw.strip().title()


def suggest_unit(raw: str) -> str:
    """Guess a recipe-friendly base unit from the slip wording."""
    low = raw.lower()
    if re.search(r"\b(ml|ltr|\dl\b|bottle|btl)\b", low):
        return "portion"
    return "piece"


def dedup_key(norm: str) -> str:
    """Identity of a line ignoring the slip's delivery-quantity column, so the
    same item across slips (with different delivered counts) merges into one."""
    return re.sub(r"\s+", " ", re.sub(r"\b\d+\b", " ", norm)).strip()


def candidate_lines(text: str) -> list[dict]:
    """Slip text → candidate line dicts. `pack_pieces` comes from a pack yield
    embedded in the name (e.g. "10PC"), NOT the delivery-quantity column."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        norm = _normalize(line)
        if not norm or not re.search(r"[a-z]", norm):
            continue
        if len(norm.replace(" ", "")) < 3:
            continue
        m = _PACK_PIECES_RE.search(line)
        pack_pieces = float(m.group(1)) if m else None
        out.append({"raw_text": line, "norm": norm, "pack_pieces": pack_pieces})
    return out


# ---------------------------------------------------------------------------
# CP Bangladesh invoice extraction (owner "Extract ingredients" screen)
# ---------------------------------------------------------------------------

# Lines to skip: invoice metadata, column headers, total rows
_CP_META_RE = re.compile(
    r"(?i)\b("
    r"invoice|receipt|bin\s*no|bin\b|"
    r"customer\s*(name)?|deliver\s*(to|y)?|address|"
    r"phone|mobile|email|fax|"
    r"sub\s*-?\s*total|grand\s*total|net\s*total|"
    r"total\s*amount|\btotal\b\s*:|"
    r"\bvat\b|tax\s*amount|"
    r"discount|delivery\s*charge|transport|"
    r"signature|authorized|received\s*by|prepared\s*by|"
    r"taka\s+in\s+words|amount\s+in\s+words|"
    r"sl\.?\s*no\.?|product\s*/\s*service|service\s*name|"
    r"\bqty\b|\bquantity\b|unit\s*price|unit\s*rate|\brate\b|\bvalue\b|"
    r"page\s*\d|original|duplicate|copy\b"
    r")\b"
)

# Trailing "QTY UNIT PRICE PRICE ..." pattern at end of a table row.
# Matches e.g. " 20 Pcs 850.00 17,000.00 6.00 18,020.00"
# Does NOT match "8/10 Pcs" (the digit would follow "/" which makes `\s+\d+` fail).
_CP_TRAILING_RE = re.compile(
    r"\s+\d{1,4}\s+(?:(?:Pcs?|Kg|Gm?|g\.?|ml|L|Ltr|Set|Box|Ctn|Btl)\.?\s+)?[\d,]+\.\d{2}[\s\d,./]*$",
    re.I,
)

_CP_SERIAL_RE = re.compile(r"^\d{1,2}\.?\s+")


def extract_invoice_product_names(fileobj) -> list[str]:
    """Extract product names from a CP Bangladesh tax invoice using Tesseract.

    The invoice table has columns: SL | Product/Service Name Details | Qty | Unit | Rate | Value | VAT | Total
    We strip the serial number from the start of each row, strip the trailing
    numeric columns, then keep lines that look like food product names.
    """
    text = ocr_text_from_fileobj(fileobj)
    products: list[str] = []
    seen: set[str] = set()

    for raw in text.splitlines():
        line = raw.strip()
        if not line or len(line) < 5:
            continue

        # Skip lines that are purely numeric / price-like
        if re.match(r'^[\d\s,./%-]+$', line):
            continue

        # Skip invoice metadata, headers, total rows
        if _CP_META_RE.search(line):
            continue

        # Strip leading serial number if present (table row)
        candidate = _CP_SERIAL_RE.sub("", line).strip()

        # Strip trailing quantity + price columns
        candidate = _CP_TRAILING_RE.sub("", candidate).strip()

        if not candidate or len(candidate) < 5 or not re.search(r'[A-Za-z]', candidate):
            continue

        key = candidate.lower()
        if key not in seen:
            seen.add(key)
            products.append(candidate)

    return products


def build_existing_index():
    """Normalized index of every known alias AND ingredient name, so a slip line
    already covered by the catalog isn't re-suggested as new."""
    from catalog.models import Ingredient

    index = []
    for a in SupplierProductAlias.objects.filter(is_active=True).select_related("ingredient"):
        index.append((_normalize(a.alias_text), a.ingredient_id, a.ingredient.name))
    for ing in Ingredient.objects.filter(is_active=True):
        index.append((_normalize(ing.name), ing.id, ing.name))
    return index


def match_existing(norm: str, index):
    """Return (ingredient_id, name) if a slip line already maps to a known
    ingredient (exact, substring, or ≥60% token overlap), else None."""
    for na, iid, name in index:
        if na and na == norm:
            return iid, name
    ntok = set(norm.split())
    best, best_score = None, 0.0
    for na, iid, name in index:
        atok = set(na.split())
        if not atok:
            continue
        if na in norm or norm in na:
            return iid, name
        overlap = len(ntok & atok) / len(atok)
        if overlap > best_score:
            best_score, best = overlap, (iid, name)
    return best if best_score >= 0.6 else None
