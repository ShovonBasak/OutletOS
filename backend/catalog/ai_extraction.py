"""Claude (vision + text) powered extraction for slips and menus.

Uses the official Anthropic SDK (``anthropic``) with Claude Opus 4.8, reading the
API key from ``ANTHROPIC_API_KEY``. All calls use strict structured outputs so
Claude's response is guaranteed to match the requested JSON schema. Falls back
gracefully to Tesseract OCR in stock/extraction.py if the SDK is missing or the
key is not set. Override the model with ``CLAUDE_MODEL`` if needed.
"""
from __future__ import annotations

import base64
import json
import os
import time

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-4-8")


class LLMUnavailable(Exception):
    """No API key, SDK missing, or the API call failed — caller should fall back."""


def available() -> bool:
    """True when the Claude extraction path can be used."""
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _client():
    try:
        import anthropic
    except ImportError as exc:
        raise LLMUnavailable("anthropic SDK not installed — run: pip install anthropic") from exc
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise LLMUnavailable("ANTHROPIC_API_KEY not set")
    return anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment


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


def _to_strict_schema(node):
    """Convert a nullable-style JSON schema into Anthropic strict structured-output
    form: every object gets ``additionalProperties: false`` and lists all its keys
    in ``required``, and ``{"nullable": true}`` becomes a ``["type", "null"]`` union.
    """
    if isinstance(node, list):
        return [_to_strict_schema(x) for x in node]
    if not isinstance(node, dict):
        return node

    out = {k: v for k, v in node.items() if k != "nullable"}
    if "properties" in out and isinstance(out["properties"], dict):
        out["properties"] = {k: _to_strict_schema(v) for k, v in out["properties"].items()}
        out["required"] = list(out["properties"].keys())
        out["additionalProperties"] = False
    if "items" in out:
        out["items"] = _to_strict_schema(out["items"])

    if node.get("nullable") and isinstance(out.get("type"), str):
        out["type"] = [out["type"], "null"]
    return out


def _call(content: list[dict], system: str, schema: dict) -> dict:
    """Send one user message (image and/or text blocks) to Claude with strict
    structured output and return the parsed JSON dict. Raises LLMUnavailable on
    any API/parse failure so callers can fall back."""
    try:
        import anthropic
    except ImportError as exc:
        raise LLMUnavailable("anthropic SDK not installed — run: pip install anthropic") from exc

    client = _client()
    strict = _to_strict_schema(schema)

    resp = None
    last_exc: Exception | None = None
    for attempt in range(3):  # up to 3 tries (0, 1, 2)
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_config={"format": {"type": "json_schema", "schema": strict}},
            )
            break
        except anthropic.RateLimitError as exc:
            raise LLMUnavailable(
                "Claude rate limit reached — wait a moment and retry, or check the plan's limits."
            ) from exc
        except (anthropic.APIConnectionError, anthropic.InternalServerError) as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(2 ** attempt)  # 1 s then 2 s between retries
                continue
            raise LLMUnavailable(f"Claude is temporarily unavailable: {exc}") from exc
        except anthropic.APIStatusError as exc:
            raise LLMUnavailable(f"Claude API error ({exc.status_code}): {exc.message}") from exc

    if resp is None:  # pragma: no cover — loop always breaks or raises
        raise LLMUnavailable("Claude is temporarily unavailable.") from last_exc

    if getattr(resp, "stop_reason", None) == "refusal":
        raise LLMUnavailable("Claude declined to process this slip.")

    text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        raise LLMUnavailable(f"Claude returned invalid JSON: {exc}") from exc


def _run(images: list[bytes], system: str, instruction: str, schema: dict) -> dict:
    """Vision path: send slip image(s) + instruction to Claude → structured JSON."""
    content: list[dict] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": _media_type(img),
                "data": base64.standard_b64encode(img).decode("ascii"),
            },
        }
        for img in images
    ]
    content.append({"type": "text", "text": instruction})
    return _call(content, system, schema)


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
    wording, excluding anything already in `known_names`.

    Primary path: PaddleOCR PP-StructureV3 — table-aware extraction that maps
    column headers precisely, giving cleaner raw_text than plain-text OCR.
    Fallback:     Claude vision — handles badly-lit / skewed images where the
    table structure is ambiguous.
    """
    # ── PaddleOCR primary ────────────────────────────────────────────────────
    try:
        import io
        from stock.ocr import (
            PaddleOcrUnavailable, PreprocessingError,
            extract_ingredients_from_slip,
        )
        from stock.ocr.normalizer import (
            suggest_clean_name, suggest_unit, suggest_pack_pieces,
        )

        known_lower = {n.lower() for n in known_names}
        agg: dict[str, dict] = {}

        for img_bytes in images:
            raw_names = extract_ingredients_from_slip(io.BytesIO(img_bytes))
            for raw in raw_names:
                key = raw.lower().strip()
                if key in known_lower:
                    continue
                if key not in agg:
                    agg[key] = {
                        "raw_text": raw,
                        "suggested_name": suggest_clean_name(raw),
                        "suggested_unit": suggest_unit(raw),
                        "suggested_qty_per_pack": suggest_pack_pieces(raw),
                        "cost_per_pack": None,
                        "tracking_mode": "RECIPE_LINKED",
                        "is_probably_not_ingredient": False,
                        "seen_in_slips": 0,
                    }
                agg[key]["seen_in_slips"] += 1

        if agg:
            return list(agg.values())
        # Zero results could mean table wasn't found — let Claude try.
    except (PaddleOcrUnavailable, PreprocessingError):
        pass
    except ImportError:
        pass

    # ── Claude fallback ──────────────────────────────────────────────────────
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
    ingredient name where possible (else matched_ingredient=null = Unrecognized).

    Primary path: PaddleOCR PP-StructureV3 — reads the table columns precisely
    (product name, qty, unit) and resolves via the alias/fuzzy matching layer.
    Fallback:     Claude vision — handles degraded images and ambiguous layouts.

    Returns list of {"raw_text", "matched_ingredient", "quantity", "unit"}.
    """
    # ── PaddleOCR primary ────────────────────────────────────────────────────
    try:
        import io
        from stock.ocr import PaddleOcrUnavailable, PreprocessingError, extract_slip
        from catalog.models import Ingredient

        all_results: list[dict] = []
        for img_bytes in images:
            parsed = extract_slip(io.BytesIO(img_bytes))
            for item in parsed["items"]:
                ing_id = item["matched_ingredient_id"]
                matched_name = None
                if ing_id:
                    try:
                        matched_name = Ingredient.objects.get(pk=ing_id).name
                    except Ingredient.DoesNotExist:
                        pass
                all_results.append({
                    "raw_text": item["raw_text"],
                    "matched_ingredient": matched_name,
                    "quantity": item["quantity"],
                    "unit": item["unit"],
                })

        if all_results:
            return all_results
        # Empty might mean no table found — let Claude try.
    except (PaddleOcrUnavailable, PreprocessingError):
        pass
    except ImportError:
        pass

    # ── Claude fallback ──────────────────────────────────────────────────────
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


# ---------------------------------------------------------------------------
# 4. Historic stock-in slip extraction (admin import of past purchase slips)
# ---------------------------------------------------------------------------
_HISTORIC_STOCKIN_SCHEMA = {
    "type": "object",
    "required": ["date", "items"],
    "properties": {
        "date": {
            "type": "string",
            "nullable": True,
            "description": "Invoice/delivery date in ISO format YYYY-MM-DD, or null if not found.",
        },
        "subtotal": {
            "type": "number",
            "nullable": True,
            "description": "Slip subtotal before VAT in BDT (numeric only, no currency symbol).",
        },
        "vat_total": {
            "type": "number",
            "nullable": True,
            "description": "Total VAT / tax amount on the slip in BDT.",
        },
        "grand_total": {
            "type": "number",
            "nullable": True,
            "description": "Grand total after all taxes in BDT. This is the final amount paid.",
        },
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["raw_text", "matched_ingredient", "quantity", "unit",
                             "rate", "total_amount", "line_total"],
                "properties": {
                    "raw_text": {
                        "type": "string",
                        "description": "Product/service name exactly as printed on the slip.",
                    },
                    "matched_ingredient": {
                        "type": "string",
                        "nullable": True,
                        "description": "Exact catalog ingredient name, or null if no confident match.",
                    },
                    "quantity": {
                        "type": "number",
                        "nullable": True,
                        "description": "Delivered quantity (Qty column).",
                    },
                    "unit": {"type": "string", "enum": ["PACK", "PIECE"]},
                    "rate": {
                        "type": "number",
                        "nullable": True,
                        "description": "Per Unit Price column — cost per pack/piece BEFORE any tax (BDT).",
                    },
                    "total_amount": {
                        "type": "number",
                        "nullable": True,
                        "description": "Total Amount column — pre-tax line subtotal = quantity × rate (BDT).",
                    },
                    "sd_rate": {
                        "type": "number",
                        "nullable": True,
                        "description": "Supplementary Duty percentage (SD Rate column, e.g. 0 or 10). Null if not present.",
                    },
                    "sd_amount": {
                        "type": "number",
                        "nullable": True,
                        "description": "Supplementary Duty amount for this line (BDT). Null if not present.",
                    },
                    "vat_rate": {
                        "type": "number",
                        "nullable": True,
                        "description": "VAT percentage for this line (e.g. 15). Null if not present.",
                    },
                    "vat_amount": {
                        "type": "number",
                        "nullable": True,
                        "description": "VAT amount for this line (BDT). Null if not present.",
                    },
                    "line_total": {
                        "type": "number",
                        "nullable": True,
                        "description": "Total Value including VAT & Tax — after-tax total for this line (BDT).",
                    },
                },
            },
        },
    },
}


def extract_historic_stock_in_vision(images: list[bytes], known_names: list[str]) -> dict:
    """Claude vision extraction for a stock-in slip. Raises LLMUnavailable on failure.

    Call this when PaddleOCR has already been tried and returned nothing, so we
    skip the redundant PaddleOCR pass that ``extract_historic_stock_in`` would do.
    """
    system = (
        "You are a stock-in assistant for CP Five Star, a fried-chicken outlet in Dhaka, Bangladesh. "
        "You read a photographed supplier tax invoice / delivery slip and extract structured data.\n\n"
        "INVOICE COLUMN LAYOUT (CP Bangladesh tax invoices):\n"
        "  No. | Product/Service Name | Qty | Unit | Per Unit Price | Total Amount | "
        "SD Rate | SD Amount | VAT Rate | VAT Amount | Total Value incl. VAT & Tax\n\n"
        "EXTRACTION RULES:\n"
        "- raw_text: product/service name exactly as printed\n"
        "- quantity: the Qty column value (decimal, e.g. 2.00 not 200)\n"
        "- unit: PACK if counting whole packs/cartons/bags; PIECE if individual units\n"
        "- rate: Per Unit Price column — cost per unit BEFORE any tax (BDT)\n"
        "- total_amount: Total Amount column — pre-tax subtotal = quantity × rate (BDT)\n"
        "- sd_rate: SD Rate column percentage (e.g. 0 or 10); null if column absent\n"
        "- sd_amount: SD Amount column value in BDT; null if column absent\n"
        "- vat_rate: VAT Rate column percentage (e.g. 15); null if column absent\n"
        "- vat_amount: VAT Amount column value in BDT; null if column absent\n"
        "- line_total: 'Total Value incl. VAT & Tax' column — AFTER-TAX total for this line (BDT); "
        "verify: line_total ≈ total_amount + sd_amount + vat_amount\n\n"
        "SLIP TOTALS:\n"
        "- subtotal: slip-level pre-tax subtotal (BDT)\n"
        "- vat_total: total VAT on the slip (BDT)\n"
        "- grand_total: final Grand Total after all taxes — the actual amount paid (BDT)\n\n"
        "MATCHING RULES:\n"
        "- Match product names by meaning: 'CKN PATTY 5IN' → 'Crispy Chicken Patty 5in'\n"
        "- Use EXACT catalog name when confident; null when not\n\n"
        "DATE RULES:\n"
        "- Return date as YYYY-MM-DD; use the invoice/delivery date (not expiry dates)\n\n"
        "Skip non-item rows: headers, totals, VAT summary, delivery charges, addresses."
    )
    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        "Read the attached tax invoice / delivery slip and extract all structured data.\n\n"
        "Return:\n"
        "1. Invoice/delivery date (ISO YYYY-MM-DD)\n"
        "2. Every product line — raw text, quantity, unit, rate (pre-tax per unit), "
        "total_amount (pre-tax subtotal), sd_rate, sd_amount, vat_rate, vat_amount, "
        "line_total (after-tax total), and matched catalog ingredient name\n"
        "3. Slip totals: subtotal (pre-tax), vat_total, grand_total (after tax)\n\n"
        f"Our ingredient catalog: {known}\n\n"
        "Do not skip any product line, even unrecognized ones. "
        "Return null for any field that cannot be read from the slip."
    )
    return _run(images, system, instruction, _HISTORIC_STOCKIN_SCHEMA)


# ---------------------------------------------------------------------------
# 4b. Text restructuring — OCR raw text → structured JSON (no image sent)
# ---------------------------------------------------------------------------
def _run_text(text: str, system: str, instruction: str, schema: dict) -> dict:
    """Text path: send already-OCR'd text (no image) to Claude → structured JSON.

    Only text goes over the wire, so this *restructures* OCR'd invoice text into
    columns rather than re-reading the image with vision — cheaper and faster.
    """
    content = [{"type": "text", "text": instruction + "\n\n----- OCR TEXT -----\n" + text}]
    return _call(content, system, schema)


def restructure_slip_text(ocr_text: str, known_names: list[str]) -> dict:
    """Restructure raw OCR text of a CP Bangladesh tax invoice into structured JSON.

    Input is the plain text that PaddleOCR / Tesseract already extracted from the
    slip (character recognition already done locally). Claude's only job here is to
    understand the column layout and shape the numbers into rows — it is NOT reading
    an image, so this is the cheap text-token path.

    Returns the same dict shape as ``extract_historic_stock_in_vision``. Numeric
    values are taken verbatim from the OCR text; ``verify_and_correct`` afterwards
    reconciles them against the invoice math (fixing OCR digit-drops like 2.00→200).
    """
    system = (
        "You restructure OCR-extracted text from CP Five Star supplier tax invoices "
        "(Dhaka, Bangladesh) into structured JSON. The character recognition is already "
        "done — do NOT invent digits or change numbers; only assign each already-present "
        "number to the correct column and group the row's fields together.\n\n"
        "INVOICE COLUMN LAYOUT (left to right):\n"
        "  No. | Product/Service Name | Supply Unit | Qty | Per Unit Price | Total Amount | "
        "SD Rate | SD Amount | VAT Rate | VAT Amount | Total Value incl. VAT & Tax\n\n"
        "FIELD MAPPING per product row:\n"
        "- raw_text: the product/service name as printed\n"
        "- quantity: Qty column\n"
        "- unit: PACK if the supply unit is a pack/carton/bag; PIECE for individual units\n"
        "- rate: Per Unit Price (pre-tax per unit)\n"
        "- total_amount: Total Amount (pre-tax subtotal = quantity × rate)\n"
        "- sd_rate / sd_amount: Supplementary Duty percentage / amount; null if absent\n"
        "- vat_rate / vat_amount: VAT percentage / amount; null if absent\n"
        "- line_total: Total Value incl. VAT & Tax (after-tax total for the row)\n\n"
        "SLIP TOTALS: subtotal (pre-tax), vat_total, grand_total (after tax).\n"
        "DATE: return YYYY-MM-DD from the invoice/delivery date (not expiry).\n"
        "MATCHING: match product names by meaning to the catalog; null when unsure.\n"
        "Skip non-item lines: headers, column names, totals rows, signatures, seals, "
        "invoice/BIN numbers, addresses. Never merge two products into one row."
    )
    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        "Restructure the OCR text below into the invoice JSON schema. Keep every number "
        "exactly as it appears in the text; just place it in the right column.\n\n"
        f"Our ingredient catalog: {known}"
    )
    return _run_text(ocr_text, system, instruction, _HISTORIC_STOCKIN_SCHEMA)


# ---------------------------------------------------------------------------
# 4c. Deterministic math verification / correction
# ---------------------------------------------------------------------------
def verify_and_correct(parsed: dict, tolerance: float = 0.05) -> dict:
    """Reconcile each line against the invoice math and fix OCR misreads in place.

    OCR frequently drops a decimal point ("2.00" → "200"). Because every CP
    Bangladesh line carries qty, per-unit rate and a pre-tax Total Amount, the
    correct quantity is recoverable arithmetically: qty = total_amount ÷ rate.

    For each item this:
      * corrects ``quantity`` when ``quantity × rate`` diverges from
        ``total_amount`` by more than ``tolerance`` (back-computed from the two
        values OCR is least likely to both misread);
      * fills ``total_amount`` from ``quantity × rate`` when it is missing;
      * fills ``line_total`` from ``total_amount + sd_amount + vat_amount`` when
        it is missing;
      * (re)computes ``unit_price`` as ``line_total ÷ quantity`` (after-tax per
        unit — what StockInItem stores);
      * appends human-readable strings to ``item["flags"]`` for anything that
        still fails to reconcile after correction.

    Returns the same dict (mutated). Never raises; missing fields are skipped.
    """
    def _num(v):
        try:
            return float(v) if v is not None and v != "" else None
        except (TypeError, ValueError):
            return None

    def _close(a, b):
        if a is None or b is None:
            return True  # can't check → don't flag
        if b == 0:
            return abs(a) < 1e-6
        return abs(a - b) / abs(b) <= tolerance

    for item in parsed.get("items", []):
        flags: list[str] = []
        qty = _num(item.get("quantity"))
        rate = _num(item.get("rate"))
        total_amount = _num(item.get("total_amount"))
        sd_amount = _num(item.get("sd_amount"))
        vat_amount = _num(item.get("vat_amount"))
        line_total = _num(item.get("line_total"))

        # 1. Correct qty via qty = total_amount / rate when the product diverges.
        if qty and rate and total_amount and total_amount > 0:
            if abs(qty * rate - total_amount) / total_amount > tolerance:
                computed = round(total_amount / rate, 2)
                if computed > 0:
                    flags.append(f"qty {qty:g} corrected to {computed:g} (total_amount÷rate)")
                    qty = computed

        # 2. Backfill pre-tax subtotal.
        if total_amount is None and qty and rate:
            total_amount = round(qty * rate, 2)

        # 3. Backfill after-tax line total.
        if line_total is None and total_amount is not None:
            line_total = round(total_amount + (sd_amount or 0) + (vat_amount or 0), 2)

        # 4. unit_price = after-tax total ÷ qty (what the model stores).
        unit_price = round(line_total / qty, 4) if (line_total and qty and qty > 0) else None

        # 5. Flag residual inconsistencies for staff review.
        if total_amount is not None and sd_amount is not None and vat_amount is not None \
                and line_total is not None:
            if not _close(total_amount + sd_amount + vat_amount, line_total):
                flags.append("line_total ≠ total_amount + sd + vat")
        if qty is not None and qty <= 0:
            flags.append("quantity is zero or negative")

        item["quantity"] = qty
        item["rate"] = rate
        item["total_amount"] = total_amount
        item["line_total"] = line_total
        item["unit_price"] = unit_price
        item["flags"] = flags

    # Slip-level reconciliation (flag only — never auto-edit the printed totals).
    sub = None
    vat = None
    grand = None
    try:
        sub = float(parsed["subtotal"]) if parsed.get("subtotal") not in (None, "") else None
        vat = float(parsed["vat_total"]) if parsed.get("vat_total") not in (None, "") else None
        grand = float(parsed["grand_total"]) if parsed.get("grand_total") not in (None, "") else None
    except (TypeError, ValueError):
        pass
    slip_flags: list[str] = []
    if sub is not None and vat is not None and grand is not None and not _close(sub + vat, grand):
        slip_flags.append("subtotal + vat ≠ grand_total")
    parsed["flags"] = slip_flags
    return parsed


def _ocr_text_lines(image_bytes: bytes) -> str:
    """Local OCR of one slip image → layout-preserving plain text.

    Strategy:
      1. PP-StructureV3 (table-aware): when the slip has a bordered table,
         PP-Structure returns HTML where all text within each cell is already
         grouped. Output is pipe-delimited rows — Claude sees complete column
         names like "Total Value Including VAT & TAX (Taka)" on one line.
      2. Plain text OCR with column-aware header merging: when PP-Structure
         finds no HTML table, PaddleOCR returns individual text boxes. A
         multi-line table header (e.g. the CP Bangladesh Mushak-6.3 form where
         column titles wrap across 3–4 visual lines) is re-merged column-by-
         column using the x-centre of the first header row as anchors, so each
         column's complete title appears on one line before the data rows.

    Raises PaddleOcrUnavailable / PreprocessingError on failure.
    """
    import io
    import re as _re
    from stock.ocr.preprocessing import load_and_preprocess

    image_bgr = load_and_preprocess(io.BytesIO(image_bytes))

    # ── Pass 1: PP-Structure (cell-boundary-aware) ───────────────────────────
    try:
        from stock.ocr.engine import run as run_pp
        from stock.ocr.table_parser import html_to_rows

        regions = run_pp(image_bgr)
        table_lines: list[str] = []
        text_lines: list[str] = []

        for region in regions:
            res = region.get("res", {})

            # HTML key is the definitive signal that table parsing ran;
            # PP-Structure sometimes labels table regions as "figure".
            html = ""
            if isinstance(res, dict):
                html = res.get("html", "") or res.get("html_str", "")
            elif isinstance(res, str) and "<table" in res:
                html = res

            if html:
                rows = html_to_rows(html)
                for row in rows:
                    table_lines.append("  |  ".join(cell for cell in row))
                continue

            # Non-table region: collect plain text
            if isinstance(res, list):
                for item in res:
                    if isinstance(item, dict):
                        t = (item.get("text") or item.get("txt") or "").strip()
                        if t:
                            text_lines.append(t)
                    elif isinstance(item, (list, tuple)) and len(item) >= 2:
                        inner = item[1]
                        t = (inner[0] if isinstance(inner, (list, tuple)) and inner
                             else str(inner)).strip()
                        if t:
                            text_lines.append(t)
            elif isinstance(res, dict):
                t = (res.get("text") or res.get("txt") or "").strip()
                if t:
                    text_lines.append(t)

        if table_lines:
            parts = (text_lines + [""] + table_lines) if text_lines else table_lines
            return "\n".join(parts)
    except Exception:
        pass  # fall through to plain text OCR

    # ── Pass 2: plain text OCR with column-aware header merging ─────────────
    from stock.ocr.engine import run_text_ocr

    boxes = run_text_ocr(image_bgr)
    # Each entry: (y_center, x_left, x_right, height, text)
    entries: list[tuple[float, float, float, float, str]] = []
    for box in boxes:
        try:
            bbox, (text, _conf) = box[0], box[1]
        except (IndexError, TypeError, ValueError):
            continue
        if not text:
            continue
        ys = [p[1] for p in bbox]
        xs = [p[0] for p in bbox]
        entries.append((
            sum(ys) / len(ys),   # y_center
            min(xs),              # x_left
            max(xs),              # x_right
            max(ys) - min(ys),   # height
            text,
        ))
    if not entries:
        return ""

    entries.sort(key=lambda e: (e[0], e[1]))
    heights = sorted(e[3] for e in entries if e[3] > 0)
    row_tol = (heights[len(heights) // 2] * 0.6) if heights else 12.0

    # Group into visual rows by y-centre proximity
    # Each row: [y_center, [(x_left, x_right, text), ...]]
    rows_g: list[list] = []
    for y_c, x_l, x_r, _h, text in entries:
        if rows_g and abs(y_c - rows_g[-1][0]) <= row_tol:
            rows_g[-1][1].append((x_l, x_r, text))
        else:
            rows_g.append([y_c, [(x_l, x_r, text)]])

    # ── Detect where the data rows start ─────────────────────────────────────
    # Data rows: leftmost cell is a serial number (digit-only) AND at least one
    # other cell contains alphabetic text (product name).  All-digit rows
    # (column-numbering rows like "1  2  3  4  5  7  8  9  10  11") are skipped.
    data_start = len(rows_g)
    for i, (_y, cells) in enumerate(rows_g):
        cells_s = sorted(cells, key=lambda c: c[0])
        row_text = " ".join(t for _, _, t in cells_s)
        if not any(c.isalpha() for c in row_text):
            continue  # all-digit column-numbering row → skip
        first = cells_s[0][2].strip() if cells_s else ""
        rest = " ".join(t for _, _, t in cells_s[1:])
        if _re.match(r"^\d+$", first) and any(c.isalpha() for c in rest):
            data_start = i
            break

    # ── Merge multi-line header into one row ──────────────────────────────────
    # Collect all non-digit text boxes from every header row, then group them
    # by x-position into columns using the first header row as anchors.
    if data_start > 1:
        first_row_cells = sorted(rows_g[0][1], key=lambda c: c[0])
        # Column anchors: x-centre of each box in the first header row
        anchors: list[float] = [(xl + xr) / 2 for xl, xr, _ in first_row_cells]
        merged: dict[float, list[str]] = {a: [t] for a, (_, _, t) in zip(anchors, first_row_cells)}

        for i in range(1, data_start):
            _y, cells = rows_g[i]
            row_text = " ".join(t for _, _, t in cells)
            if not any(c.isalpha() for c in row_text):
                continue  # skip all-digit column-numbering rows
            for x_l, x_r, text in cells:
                x_c = (x_l + x_r) / 2
                nearest = min(anchors, key=lambda a: abs(a - x_c))
                merged[nearest].append(text)

        header_cells = sorted(merged.items())  # sorted by x-anchor
        header_line = "  ".join(" ".join(parts) for _, parts in header_cells)

        data_lines: list[str] = []
        for _y, cells in rows_g[data_start:]:
            cells_s = sorted(cells, key=lambda c: c[0])
            line = "  ".join(t for _, _, t in cells_s)
            if line.strip():
                data_lines.append(line)

        return header_line + ("\n" + "\n".join(data_lines) if data_lines else "")

    # Single-row header or no header detected — output rows as-is
    lines = []
    for _y, cells in rows_g:
        cells_s = sorted(cells, key=lambda c: c[0])
        lines.append("  ".join(t for _, _, t in cells_s))
    return "\n".join(lines)


def extract_historic_stock_in(images: list[bytes], known_names: list[str]) -> dict:
    """Extract date + received line items from a historical purchase/delivery slip.

    Pipeline (owner-chosen):
      1. Local OCR (PaddleOCR) recognises the characters → layout-preserving text.
      2. Claude restructures that text into columns (cheap text-token call).
      3. verify_and_correct reconciles the numbers, fixing OCR digit-drops.

    Fallbacks: if local OCR is unavailable → Claude vision; if Claude is
    unavailable (no key / rate limit) → the local heuristic parser. Every path is
    passed through verify_and_correct so the math is always reconciled.

    Returns {"date", "subtotal", "vat_total", "grand_total", "items": [...], "flags"}.
    Each item: {"raw_text", "matched_ingredient" (name|null), "quantity", "unit",
    "rate", "total_amount", "sd_rate", "sd_amount", "vat_rate", "vat_amount",
    "line_total", "unit_price", "flags"}.
    """
    # ── 1+2. Local OCR → Claude text restructure ─────────────────────────────
    try:
        from stock.ocr import PaddleOcrUnavailable, PreprocessingError

        ocr_text = "\n\n".join(t for t in (_ocr_text_lines(b) for b in images) if t)
        if ocr_text.strip():
            try:
                parsed = restructure_slip_text(ocr_text, known_names)
                if parsed.get("items"):
                    return verify_and_correct(parsed)
            except LLMUnavailable:
                # Claude down / no key — fall through to the local heuristic parser.
                return _historic_heuristic(images)
    except (PaddleOcrUnavailable, PreprocessingError, ImportError):
        pass  # no local OCR — try Claude vision below

    # ── Claude vision (no local OCR available) ───────────────────────────────
    try:
        return verify_and_correct(extract_historic_stock_in_vision(images, known_names))
    except LLMUnavailable:
        return _historic_heuristic(images)


def _historic_heuristic(images: list[bytes]) -> dict:
    """Local-only best-effort fallback: the PP-Structure/positional heuristic parser.

    Used when Claude cannot restructure (no key / rate limit). Output is less reliable
    (verify_and_correct still reconciles the math and flags what it cannot fix).
    """
    import io
    from stock.ocr import extract_slip
    from catalog.models import Ingredient as _Ingredient

    merged: dict = {
        "date": None, "subtotal": None, "vat_total": None, "grand_total": None,
        "items": [],
    }
    try:
        for img_bytes in images:
            parsed = extract_slip(io.BytesIO(img_bytes))
            if not merged["date"] and parsed.get("date"):
                merged["date"] = parsed["date"]
            for key in ("subtotal", "vat_total", "grand_total"):
                if merged[key] is None and parsed.get(key) is not None:
                    merged[key] = parsed[key]
            for item in parsed.get("items", []):
                ing_id = item.get("matched_ingredient_id")
                matched_name = None
                if ing_id:
                    try:
                        matched_name = _Ingredient.objects.get(pk=ing_id).name
                    except _Ingredient.DoesNotExist:
                        pass
                merged["items"].append({
                    "raw_text":         item["raw_text"],
                    "matched_ingredient": matched_name,
                    "quantity":         item["quantity"],
                    "unit":             item["unit"],
                    "rate":             item.get("rate"),
                    "total_amount":     item.get("total_amount"),
                    "sd_rate":          item.get("sd_rate"),
                    "sd_amount":        item.get("sd_amount"),
                    "vat_rate":         item.get("vat_rate"),
                    "vat_amount":       item.get("vat_amount"),
                    "line_total":       item.get("line_total"),
                })
    except Exception:  # noqa: BLE001 — degrade to empty rather than 500
        pass
    return verify_and_correct(merged)


# ---------------------------------------------------------------------------
# 5. Historic prep-log slip extraction (admin import of past preparation logs)
# ---------------------------------------------------------------------------
_HISTORIC_PREPLOG_SCHEMA = {
    "type": "object",
    "required": ["date", "items"],
    "properties": {
        "date": {
            "type": "string",
            "nullable": True,
            "description": "Preparation date in ISO format YYYY-MM-DD, or null if not found.",
        },
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["raw_text", "matched_product", "pieces_prepared", "source"],
                "properties": {
                    "raw_text": {"type": "string", "description": "Line exactly as printed."},
                    "matched_product": {
                        "type": "string",
                        "nullable": True,
                        "description": "Exact catalog product name, or null if no confident match.",
                    },
                    "pieces_prepared": {
                        "type": "integer",
                        "nullable": True,
                        "description": "Number of finished, ready-to-sell pieces.",
                    },
                    "source": {
                        "type": "string",
                        "enum": ["FRESH", "CARRIED_FORWARD"],
                        "description": "FRESH if fried/cooked fresh; CARRIED_FORWARD if moved from yesterday.",
                    },
                },
            },
        },
    },
}


def extract_historic_prep_log(images: list[bytes], known_products: list[str]) -> dict:
    """Extract date + preparation entries from a historical prep-log slip.

    Returns {"date": "YYYY-MM-DD" or None, "items": [...]}.
    """
    system = (
        "You are a preparation log assistant for CP Five Star, a fried-chicken outlet in Dhaka, Bangladesh. "
        "You read a handwritten or printed preparation/production log slip and extract:\n"
        "1. The date of preparation\n"
        "2. Each product prepared, how many pieces, and whether freshly made or carried forward from the previous day\n\n"
        "MATCHING RULES:\n"
        "- Match product names by meaning: '3pc Crispy' → 'Crispy Chicken 3pc'\n"
        "- Use EXACT catalog name when confident, null when not\n\n"
        "QUANTITY RULES:\n"
        "- pieces_prepared = total finished, ready-to-sell pieces of that product\n"
        "- source = FRESH if freshly fried/prepared; CARRIED_FORWARD if moved from yesterday's leftovers"
    )
    known = ", ".join(sorted(known_products)) or "(none yet)"
    instruction = (
        "Read the attached preparation log slip. Extract:\n"
        "1. The preparation date (ISO YYYY-MM-DD)\n"
        "2. Each prepared product — raw text, pieces prepared, matched product name, and FRESH or CARRIED_FORWARD\n\n"
        f"Our product catalog: {known}\n\n"
        "Do not skip any product line."
    )
    return _run(images, system, instruction, _HISTORIC_PREPLOG_SCHEMA)
