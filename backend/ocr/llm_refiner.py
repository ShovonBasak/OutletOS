"""LLM post-processor: uses Gemini 2.5 Flash to clean OCR-extracted invoice data.

Why Gemini 2.5 Flash?
  - Latest free-tier Flash model on Google AI Studio (as of July 2026).
  - Free tier: up to 15–20 RPM, 1 million tokens per day (Google AI Studio key).
  - Text-only input (no images) → cheapest token category, sub-second latency.
  - Structured JSON output via response_mime_type="application/json" + schema.
  - Already in project deps (google-genai).
  - Override via GEMINI_MODEL env var if a newer model becomes available.

This step runs on the PARSED DICT (text/numbers), not on raw images. It fixes:
  - OCR typos in product names ("Chcken Pop Stck" → "Chicken Pop Stick FPP Chilled")
  - Missing quantities (inferred from unit_price and total when both are present)
  - Garbled invoice numbers and inconsistent unit strings

It is OPTIONAL — extract_invoice() works without it. Pass an instance to opt in:

    from ocr.llm_refiner import GeminiInvoiceRefiner
    result = extract_invoice("/slip.jpg", refiner=GeminiInvoiceRefiner())

The refiner never raises — if Gemini is unavailable or returns bad JSON, it logs a
warning and returns the original parsed dict unchanged.
"""
from __future__ import annotations

import json
import logging
import os
import time

logger = logging.getLogger(__name__)

# Default model: Gemini 2.0 Flash.
# Override via env var GEMINI_MODEL or the model= constructor arg.
DEFAULT_MODEL = "gemini-2.5-flash"

# ---------------------------------------------------------------------------
# JSON schema for the refined output  (mirrors the InvoiceParser raw dict)
# ---------------------------------------------------------------------------

_SCHEMA: dict = {
    "type": "object",
    "required": ["invoice_number", "invoice_date", "supplier", "customer",
                 "items", "summary"],
    "properties": {
        "invoice_number": {"type": "string"},
        "invoice_date":   {"type": "string"},
        "supplier":       {"type": "string"},
        "customer":       {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["product_name", "quantity", "unit",
                             "unit_price", "amount", "vat", "total"],
                "properties": {
                    "product_name": {"type": "string"},
                    "quantity":     {"type": "number", "nullable": True},
                    "unit":         {"type": "string"},
                    "unit_price":   {"type": "number", "nullable": True},
                    "rate":         {"type": "number", "nullable": True},
                    "vat_rate":     {"type": "number", "nullable": True},
                    "amount":       {"type": "number", "nullable": True},
                    "vat":          {"type": "number", "nullable": True},
                    "total":        {"type": "number", "nullable": True},
                },
            },
        },
        "summary": {
            "type": "object",
            "required": ["subtotal", "vat", "grand_total"],
            "properties": {
                "subtotal":    {"type": "number", "nullable": True},
                "vat":         {"type": "number", "nullable": True},
                "grand_total": {"type": "number", "nullable": True},
            },
        },
    },
}

# ---------------------------------------------------------------------------
# System instruction
# ---------------------------------------------------------------------------

_SYSTEM = """\
You are an expert at correcting OCR errors in CP Bangladesh tax invoice data.

You receive a JSON object extracted by PaddleOCR from a printed tax invoice.
OCR commonly produces: missing or swapped letters in product names, null quantities
when a column was misread, garbled invoice numbers, and inconsistent unit strings.

Your job is to return the SAME JSON structure with the following corrections applied:

PRODUCT NAMES
  - Fix OCR typos. CP Bangladesh sells chilled chicken products:
    burgers, pop sticks, chicken balls, patties, wraps, and similar.
  - Do not invent words. If uncertain, keep the original text.

QUANTITIES
  - If quantity is null but both unit_price and total are present and non-zero,
    infer: quantity = round(total / unit_price, 2).
    Only infer when the result is positive and less than 10 000.
  - Do not change quantities that are already present.

UNITS
  - Normalise to consistent capitalisation:
    "pck" / "PCK" / "pack" → "Pack"
    "pcs" / "PCS" / "piece" / "Pcs" → "Piece"
    "kg" / "KG" → "Kg"
    Leave other units as-is.

PRICES
  - Do NOT change any numeric price values (unit_price, amount, vat, total,
    subtotal, grand_total). Return them exactly as given.

HEADER FIELDS
  - If invoice_number looks garbled (e.g. "INV O01-2024" → "INV-001-2024"),
    apply minimal obvious fixes only.
  - Leave invoice_date, supplier, customer unchanged.

STRUCTURE
  - Return the exact same JSON keys. Do not add or remove items.
  - Return ONLY the JSON object — no explanation, no markdown.
"""


# ---------------------------------------------------------------------------
# GeminiInvoiceRefiner
# ---------------------------------------------------------------------------


class GeminiInvoiceRefiner:
    """Optional LLM post-processor: cleans the InvoiceParser raw dict via Gemini.

    Args:
        model:   Gemini model ID. Default: ``gemini-2.5-flash`` (latest free tier).
        api_key: Google AI Studio API key. Falls back to ``GEMINI_API_KEY``
                 or ``GOOGLE_API_KEY`` env vars.
        timeout: Seconds to wait for each Gemini response (default 30).

    The refiner is silent on failure — it logs a warning and returns the original
    dict so that the rest of the pipeline is unaffected.
    """

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        timeout: int = 30,
    ) -> None:
        self._model = model or os.getenv("GEMINI_MODEL", DEFAULT_MODEL)
        self._api_key = (
            api_key
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("GOOGLE_API_KEY")
        )
        self._timeout = timeout

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def refine(self, parsed: dict) -> dict:
        """Return a cleaned copy of *parsed*, or *parsed* itself on failure.

        Never raises. Errors are logged at WARNING level.
        """
        if not parsed.get("items"):
            return parsed  # nothing to refine

        try:
            return self._call_gemini(parsed)
        except Exception as exc:
            logger.warning(
                "GeminiInvoiceRefiner: skipped (%s: %s) — using raw OCR output.",
                type(exc).__name__,
                exc,
            )
            return parsed

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _call_gemini(self, parsed: dict) -> dict:
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise ImportError(
                "google-genai is not installed. Run: pip install google-genai"
            ) from exc

        if not self._api_key:
            raise ValueError(
                "Gemini API key not set. "
                "Set the GEMINI_API_KEY environment variable "
                "(get a free key at aistudio.google.com)."
            )

        client = genai.Client(api_key=self._api_key)
        prompt = (
            "Clean and correct this OCR-extracted invoice JSON:\n\n"
            + json.dumps(parsed, indent=2, ensure_ascii=False)
        )

        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=self._model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=_SYSTEM,
                        response_mime_type="application/json",
                        response_schema=_SCHEMA,
                        temperature=0.1,
                    ),
                )
                break
            except Exception as exc:
                msg = str(exc)
                if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                    raise RuntimeError(
                        "Gemini free-tier quota exhausted. "
                        "Make sure your key is from aistudio.google.com "
                        "(not Google Cloud Console). Try again later or "
                        "set GEMINI_MODEL=gemini-1.5-flash in .env."
                    ) from exc
                if ("503" in msg or "UNAVAILABLE" in msg) and attempt < 2:
                    last_exc = exc
                    time.sleep(2 ** attempt)
                    continue
                raise
        else:
            raise RuntimeError(
                "Gemini is temporarily unavailable (503). "
                "Using raw OCR output instead."
            ) from last_exc

        raw_text = response.text.strip() if response.text else ""
        if not raw_text:
            raise ValueError("Gemini returned an empty response.")

        refined: dict = json.loads(raw_text)

        # Guard: refined must have items (same or more than original)
        if "items" not in refined or not isinstance(refined["items"], list):
            raise ValueError("Gemini response is missing 'items' array.")

        if len(refined["items"]) != len(parsed.get("items", [])):
            raise ValueError(
                f"Gemini changed item count "
                f"({len(parsed.get('items', []))} → {len(refined['items'])}). "
                "Using original."
            )

        return refined
