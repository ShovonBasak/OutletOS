"""Gemini (vision) powered extraction for slips and menus.

Uses google-genai SDK with Gemini 2.5 Flash (free tier via GEMINI_API_KEY from
Google AI Studio). Falls back gracefully to Tesseract OCR in stock/extraction.py
if the SDK is missing or the key is not set.
"""
from __future__ import annotations

import json
import os

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")


class LLMUnavailable(Exception):
    """No API key, SDK missing, or the API call failed — caller should fall back."""


def available() -> bool:
    """True when the Gemini extraction path can be used."""
    try:
        from google import genai  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("GEMINI_API_KEY"))


def _client():
    try:
        from google import genai
    except ImportError as exc:
        raise LLMUnavailable("google-genai SDK not installed") from exc
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise LLMUnavailable("GEMINI_API_KEY not set")
    return genai.Client(api_key=api_key)


def _media_type(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/png"


def _run(images: list[bytes], system: str, instruction: str, schema: dict) -> dict:
    """Send images + instruction to Gemini and return structured JSON output."""
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise LLMUnavailable("google-genai SDK not installed") from exc

    client = _client()

    contents = [
        types.Part.from_bytes(data=img, mime_type=_media_type(img))
        for img in images
    ]
    contents.append(types.Part.from_text(text=instruction))

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system,
                response_mime_type="application/json",
                response_schema=schema,
            ),
        )
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            raise LLMUnavailable(
                "Gemini free-tier quota exhausted. Make sure your API key is from "
                "Google AI Studio (aistudio.google.com) — not Google Cloud Console. "
                "If it is, you've hit the daily limit; try again tomorrow or set "
                "GEMINI_MODEL=gemini-1.5-flash in .env."
            ) from exc
        raise LLMUnavailable(f"Gemini API error: {exc}") from exc

    try:
        return json.loads(response.text)
    except (json.JSONDecodeError, AttributeError) as exc:
        raise LLMUnavailable(f"Gemini returned invalid JSON: {exc}") from exc


# ---------------------------------------------------------------------------
# 1. Ingredient extraction (owner setup — many slips at once)
# ---------------------------------------------------------------------------
_INGREDIENT_SCHEMA = {
    "type": "object",
    "required": ["products"],
    "properties": {
        "products": {
            "type": "array",
            "description": "Product names extracted from the Product/Service Name Details column, exactly as printed.",
            "items": {"type": "string"},
        }
    },
}


def extract_ingredients(images: list[bytes], known_names: list[str]) -> list[dict]:
    """Return NEW ingredient candidates across all slip images, de-duplicated by
    wording, excluding anything already in `known_names`."""
    system = """You are an OCR table extraction engine.

Your task is to extract ONLY the product names from the invoice table.

### Rules

* Extract product names only from the column Product / Service Name Details.

* Do NOT extract quantities, prices, VAT, totals, invoice numbers, dates, addresses, BIN numbers, signatures, or any header/footer text.

* Do NOT combine multiple rows into one product name.

* Preserve the product name exactly as it appears in the table.

* If a row is unclear, return the best readable product name from that row.

* Ignore empty rows."""

    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        f'Extract all product names from the "Product / Service Name Details" column '
        f"of the invoice table in the attached image(s). One product name per entry, exactly as printed.\n\n"
        f"Also skip any product already in our catalog (case-insensitive): {known}"
    )

    data = _run(images, system, instruction, _INGREDIENT_SCHEMA)

    known_lower = {n.lower() for n in known_names}
    items = []
    seen: dict[str, int] = {}
    for name in data.get("products", []):
        name = name.strip()
        if not name or name.lower() in known_lower:
            continue
        key = name.lower()
        if key in seen:
            seen[key] += 1
            for item in items:
                if item["raw_text"].lower() == key:
                    item["seen_in_slips"] += 1
        else:
            seen[key] = 1
            items.append({
                "raw_text": name,
                "suggested_name": name,
                "suggested_unit": "piece",
                "suggested_qty_per_pack": None,
                "cost_per_pack": None,
                "tracking_mode": "RECIPE_LINKED",
                "is_probably_not_ingredient": False,
                "seen_in_slips": 1,
            })
    return items


# ---------------------------------------------------------------------------
# 2. Menu extraction (import menu from a photo/screenshot)
# ---------------------------------------------------------------------------
_MENU_SCHEMA = {
    "type": "object",
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "category", "selling_price", "requires_preparation", "is_combo"],
                "properties": {
                    "name": {"type": "string"},
                    "category": {"type": "string", "description": "e.g. Burger, Chicken, Wrap, Beverage, Combo."},
                    "selling_price": {"type": "number", "nullable": True, "description": "Menu price if shown, else null."},
                    "requires_preparation": {"type": "boolean"},
                    "is_combo": {"type": "boolean"},
                },
            },
        }
    },
}


def extract_menu(images: list[bytes], known_names: list[str]) -> list[dict]:
    """Return sellable menu products from menu photos, excluding known products."""
    system = (
        "You read restaurant menu photos/screenshots and list the sellable products "
        "with their category, price, and whether they are prepared/cooked to order."
    )
    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        "List every distinct sellable menu item in the attached image(s). Exclude items "
        f"already in our catalog: {known}. Guess a sensible category and whether the item "
        "is prepared/cooked (true) or sold ready from stock like a canned drink (false)."
    )
    data = _run(images, system, instruction, _MENU_SCHEMA)
    return data.get("items", [])


# ---------------------------------------------------------------------------
# 3. Stock-in line extraction (a single delivery slip, matched to ingredients)
# ---------------------------------------------------------------------------
_STOCKIN_SCHEMA = {
    "type": "object",
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["raw_text", "matched_ingredient", "quantity", "unit"],
                "properties": {
                    "raw_text": {"type": "string", "description": "The line exactly as printed."},
                    "matched_ingredient": {"type": "string", "nullable": True, "description": "Exact catalog ingredient name, or null if no confident match."},
                    "quantity": {"type": "number", "nullable": True, "description": "How many were received."},
                    "unit": {"type": "string", "enum": ["PACK", "PIECE"]},
                },
            },
        }
    },
}


def extract_stock_in(images: list[bytes], known_names: list[str]) -> list[dict]:
    """Return received line items from one delivery slip, each matched to a known
    ingredient name where possible (else null = Unrecognized)."""
    system = """You are a stock-in assistant for CP Five Star, a fried-chicken outlet \
in Dhaka, Bangladesh. You read a photographed supplier delivery slip and extract \
each received line item with its delivered quantity, matching it to the outlet's \
known ingredient list where possible.

MATCHING RULES:
- Match by meaning, not exact spelling: "CKN PATTY 5IN" → "Crispy Chicken Patty 5in"
- Ignore case, punctuation, and common abbreviations (CKN=Chicken, BUN=Bun, PC/PCS=piece)
- If a line clearly maps to a known ingredient, use the EXACT catalog name
- If no match is confident, set matched_ingredient to null

QUANTITY RULES:
- quantity = the delivery/received amount column
- unit = PACK if quantity counts whole packs/cartons/bags; PIECE if individual units
- Skip non-item lines: totals, VAT, delivery charges, headers"""

    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        f"Read the attached delivery slip and list every received ingredient line. "
        f"For each line provide: the raw text as printed, the delivery quantity, PACK or PIECE, "
        f"and the exact catalog ingredient name it matches — or null if not confident.\n\n"
        f"Our ingredient catalog: {known}\n\n"
        f"Do not skip any product line, even unrecognized ones."
    )
    data = _run(images, system, instruction, _STOCKIN_SCHEMA)
    return data.get("items", [])
