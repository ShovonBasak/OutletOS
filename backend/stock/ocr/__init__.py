"""
PaddleOCR PP-StructureV3 extraction pipeline.

                Django API
                    │
              Upload Image / PDF
                    │
                    ▼
          ┌─────────────────────┐
          │  Preprocessing      │  (OpenCV: deskew → denoise → CLAHE)
          └─────────────────────┘
                    │
                    ▼
          ┌─────────────────────┐
          │  PP-StructureV3     │  (table detection + OCR)
          └─────────────────────┘
                    │
                    ▼
          Extract: Tables / Text / Layout
                    │
                    ▼
          ┌─────────────────────┐
          │  Custom Parser      │  (slip_parser: date + column mapping)
          └─────────────────────┘
                    │
                    ▼
          ┌─────────────────────┐
          │  Normaliser         │  (alias + fuzzy catalog resolution)
          └─────────────────────┘
                    │
                    ▼
              Normalised JSON → Database

Public surface
--------------
extract_slip(source)               → full dict with resolved ingredient IDs
extract_ingredients_from_slip(src) → list[str] of raw product names
available()                        → bool
PaddleOcrUnavailable               → exception class
PreprocessingError                 → exception class
"""
from __future__ import annotations

# Heavy dependencies (paddleocr, cv2, numpy) are imported lazily inside each
# function so that importing this package never crashes Django startup when
# PaddleOCR is not yet installed.

__all__ = [
    "available",
    "PaddleOcrUnavailable",
    "PreprocessingError",
    "extract_slip",
    "extract_ingredients_from_slip",
    "run_text_ocr",
]

# Import shared exception classes — no circular-import risk since _exceptions.py
# has zero dependencies.
from stock.ocr._exceptions import PaddleOcrUnavailable, PreprocessingError  # noqa: E402
from stock.ocr.preprocessing import load_and_preprocess


def run_text_ocr(source) -> list:
    """Convenience wrapper: preprocess image + run basic PaddleOCR text extraction.

    Returns a flat list of [bbox, (text, confidence)] pairs.
    Raises PaddleOcrUnavailable / PreprocessingError on failure.
    """
    from .engine import run_text_ocr as _run
    image_bgr = load_and_preprocess(source)
    return _run(image_bgr)


def available() -> bool:
    """True when PaddleOCR is importable (models not yet loaded)."""
    try:
        from .engine import available as _avail
        return _avail()
    except Exception:
        return False


def extract_slip(source) -> dict:
    """End-to-end: image source → normalised slip dict with catalog matches.

    Extraction strategy (both passes are PaddleOCR — no external API):
      Pass 1 — PP-StructureV3: detects table layout + OCR. Best for slips
               with visible cell borders. Returns items if a table is found.
      Pass 2 — Basic PaddleOCR text OCR: flat positional text extraction +
               row-grouping heuristics. Used automatically when Pass 1 finds
               no table regions (e.g. borderless or photo-scanned invoices).

    Args:
        source: file path (str), raw bytes, or file-like object.

    Returns::

        {
            "date":        "YYYY-MM-DD" | None,
            "subtotal":    float | None,
            "vat_total":   float | None,
            "grand_total": float | None,
            "items": [
                {
                    "raw_text":                   str,
                    "quantity":                   float | None,
                    "unit":                       "PACK" | "PIECE",
                    "unit_price":                 float | None,
                    "line_total":                 float | None,
                    "matched_ingredient_id":      int | None,
                    "matched_pack_definition_id": int | None,
                }
            ]
        }

    Raises:
        PaddleOcrUnavailable: paddleocr not installed or model load failed.
        PreprocessingError:   image cannot be read / OpenCV missing.
    """
    from .engine import run, run_text_ocr
    from .slip_parser import parse_structure_result, parse_text_ocr_lines
    from .normalizer import resolve_ingredient

    image_bgr = load_and_preprocess(source)

    # --- Pass 1: PP-StructureV3 (table-aware) --------------------------------
    raw_result = run(image_bgr)
    parsed     = parse_structure_result(raw_result)

    # --- Pass 2: basic text OCR if PP-Structure found no items ---------------
    if not parsed["items"]:
        ocr_lines   = run_text_ocr(image_bgr)
        text_parsed = parse_text_ocr_lines(ocr_lines)

        # Merge: prefer Pass 1 date/totals when available
        parsed["items"] = text_parsed["items"]
        if not parsed["date"]:
            parsed["date"] = text_parsed["date"]
        for key in ("subtotal", "vat_total", "grand_total"):
            if parsed[key] is None:
                parsed[key] = text_parsed[key]

    # --- Normalise: resolve ingredient names against catalog -----------------
    for item in parsed["items"]:
        ing_id, pack_id = resolve_ingredient(item["raw_text"])
        item["matched_ingredient_id"]      = ing_id
        item["matched_pack_definition_id"] = pack_id

    return parsed


def extract_ingredients_from_slip(source) -> list[str]:
    """Extract raw ingredient-name candidates from a slip image.

    Returns a list of raw strings (product names from the invoice table).
    Used by the owner setup flow; downstream code applies suggest_clean_name()
    to each string to produce internal ingredient names.

    Raises:
        PaddleOcrUnavailable, PreprocessingError
    """
    from .engine import run
    from .slip_parser import parse_structure_result

    image_bgr = load_and_preprocess(source)
    raw_result = run(image_bgr)
    parsed = parse_structure_result(raw_result)
    return [item["raw_text"] for item in parsed["items"]]
