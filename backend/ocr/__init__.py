"""Invoice OCR module — public surface.

Single entry point::

    from ocr import extract_invoice
    result = extract_invoice("/path/to/slip.jpg", catalog=["Chicken Pop Stick", ...])
    print(result.to_dict())

With optional Gemini LLM refinement (fixes OCR typos, infers missing quantities)::

    from ocr import extract_invoice
    from ocr.llm_refiner import GeminiInvoiceRefiner

    result = extract_invoice(
        "/path/to/slip.jpg",
        catalog=["Chicken Pop Stick FPP Chilled", ...],
        refiner=GeminiInvoiceRefiner(),   # uses GEMINI_API_KEY env var
    )

Pipeline:
    1. Preprocess  — auto-rotate, deskew, perspective, CLAHE.
    2. OCR         — PP-StructureV3 (tables) + PaddleOCR (text fallback).
    3. Parse       — column-aware table parsing + header-field extraction.
    4. Refine      — optional LLM step: fixes product-name typos, infers quantities.
    5. Match       — fuzzy-match product names against catalog (RapidFuzz).
    6. Validate    — math checks; append warnings; flag suspicious rows.

Steps 4 and 5 are independent: the refiner improves raw_text so that fuzzy matching
in step 5 has better input. If the refiner is not provided, step 4 is skipped.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from .exceptions import InvoiceParsingError, OCRExtractionError, OCRInitializationError
from .schemas import InvoiceItem, InvoiceOCRResult, InvoiceSummary

if TYPE_CHECKING:
    from .llm_refiner import GeminiInvoiceRefiner

__all__ = [
    "extract_invoice",
    "InvoiceOCRResult",
    "InvoiceSummary",
    "InvoiceItem",
    "OCRInitializationError",
    "OCRExtractionError",
    "InvoiceParsingError",
]


def extract_invoice(
    path: str,
    catalog: list[str] | None = None,
    refiner: "GeminiInvoiceRefiner | None" = None,
    matcher_min_score: float = 60.0,
    validator_tolerance: float = 0.05,
    validator_min_match_score: float = 70.0,
) -> InvoiceOCRResult:
    """Extract structured invoice data from an image file.

    Args:
        path:
            Absolute file path to the invoice image (JPEG, PNG, HEIC).
        catalog:
            Optional list of canonical product/ingredient names for fuzzy matching.
            When None, ``matched_product`` equals the (possibly refined) OCR name
            and ``match_score`` is 0.
        refiner:
            Optional :class:`~ocr.llm_refiner.GeminiInvoiceRefiner` instance.
            When provided, Gemini 2.0 Flash cleans the parsed text before fuzzy
            matching — fixing typos in product names and inferring null quantities.
            Never blocks the pipeline: if Gemini fails, raw OCR output is used.
        matcher_min_score:
            RapidFuzz score threshold 0–100. Names below this score are not matched.
        validator_tolerance:
            Fractional tolerance for line-math validation checks (default 5 %).
        validator_min_match_score:
            Emit a warning when a product's match confidence is below this score.

    Returns:
        :class:`InvoiceOCRResult` with items, summary, and warnings.

    Raises:
        OCRInitializationError: PaddleOCR failed to initialize.
        OCRExtractionError:     OCR inference failed.
        InvoiceParsingError:    OCR produced no usable data (unreadable image).
        ValueError:             Image path is invalid or unreadable by OpenCV.
    """
    from .matcher import ProductMatcher
    from .parser import InvoiceParser
    from .preprocess import preprocess
    from .service import OCRService
    from .validator import InvoiceValidator

    # Step 1 — Preprocess
    image_bgr = preprocess(path)

    # Step 2 — OCR
    service = OCRService.get_instance()
    layout_result = service.run_layout(image_bgr)
    text_result   = service.run_text(image_bgr)

    # Step 3 — Parse
    parser = InvoiceParser()
    raw = parser.parse(layout_result, text_result, image_bgr.shape)

    if not raw["items"] and not raw["invoice_date"]:
        raise InvoiceParsingError(
            "OCR produced no items and no date. "
            "The image may be too dark/blurry or is not a supported invoice format."
        )

    # Step 4 — LLM refinement (optional)
    if refiner is not None:
        raw = refiner.refine(raw)

    # Step 5 — Match product names against catalog
    matcher = ProductMatcher(catalog or [], min_score=matcher_min_score)
    items: list[InvoiceItem] = []
    for raw_item in raw["items"]:
        ocr_name: str = raw_item["product_name"]
        if catalog:
            matched_name, score = matcher.match(ocr_name)
        else:
            matched_name, score = ocr_name, 0.0

        items.append(
            InvoiceItem(
                product_name=ocr_name,
                matched_product=matched_name,
                match_score=score,
                quantity=raw_item.get("quantity"),
                unit=raw_item.get("unit") or "PACK",
                unit_price=raw_item.get("unit_price"),
                rate=raw_item.get("rate"),
                amount=raw_item.get("amount"),
                sd_rate=raw_item.get("sd_rate"),
                sd_amount=raw_item.get("sd_amount"),
                vat_rate=raw_item.get("vat_rate"),
                vat=raw_item.get("vat"),
                total=raw_item.get("total"),
            )
        )

    raw_summary = raw["summary"]
    summary = InvoiceSummary(
        subtotal=raw_summary.get("subtotal"),
        vat=raw_summary.get("vat"),
        grand_total=raw_summary.get("grand_total"),
    )

    result = InvoiceOCRResult(
        invoice_number=raw["invoice_number"],
        invoice_date=raw["invoice_date"],
        supplier=raw["supplier"],
        customer=raw["customer"],
        items=items,
        summary=summary,
        warnings=[],
    )

    # Step 6 — Validate
    validator = InvoiceValidator(
        tolerance=validator_tolerance,
        min_match_score=validator_min_match_score,
    )
    result.warnings = validator.validate(result)

    return result
