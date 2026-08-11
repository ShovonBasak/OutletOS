"""Claude (vision) powered extraction for slips and menus.

Uses the official Anthropic SDK (``anthropic``) with Claude Opus 4.8, reading the
API key from ``ANTHROPIC_API_KEY``. All calls use strict structured outputs so
Claude's response is guaranteed to match the requested JSON schema.
Override the model with ``CLAUDE_MODEL`` if needed.
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
    """
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

    Returns list of {"raw_text", "matched_ingredient", "quantity", "unit"}.
    """
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
    "required": ["invoice_number", "date", "items"],
    "properties": {
        "invoice_number": {
            "type": "string",
            "nullable": True,
            "description": "Invoice/challan number exactly as printed (e.g. 'INV-001/6419/0826'), or null if not found.",
        },
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
    """Claude vision extraction for a stock-in slip. Raises LLMUnavailable on failure."""
    system = (
        "You are a stock-in assistant for CP Five Star, a fried-chicken outlet in Dhaka, Bangladesh. "
        "You read a photographed supplier tax invoice / delivery slip and extract structured data.\n\n"
        "INVOICE HEADER:\n"
        "- invoice_number: the invoice/challan reference exactly as printed (e.g. 'INV-001/6419/0826'); null if absent\n"
        "- date: invoice/delivery date as YYYY-MM-DD; use the invoice date, not expiry dates; null if absent\n\n"
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
        "Skip non-item rows: headers, totals, VAT summary, delivery charges, addresses."
    )
    known = ", ".join(sorted(known_names)) or "(none yet)"
    instruction = (
        "Read the attached tax invoice / delivery slip and extract all structured data.\n\n"
        "Return:\n"
        "1. Invoice number/reference (exactly as printed, or null)\n"
        "2. Invoice/delivery date (ISO YYYY-MM-DD, or null)\n"
        "3. Every product line — raw text, quantity, unit, rate (pre-tax per unit), "
        "total_amount (pre-tax subtotal), sd_rate, sd_amount, vat_rate, vat_amount, "
        "line_total (after-tax total), and matched catalog ingredient name\n"
        "4. Slip totals: subtotal (pre-tax), vat_total, grand_total (after tax)\n\n"
        f"Our ingredient catalog: {known}\n\n"
        "Do not skip any product line, even unrecognized ones. "
        "Return null for any field that cannot be read from the slip."
    )
    return _run(images, system, instruction, _HISTORIC_STOCKIN_SCHEMA)


# ---------------------------------------------------------------------------
# 4b. Deterministic math verification / correction
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


def extract_historic_stock_in(images: list[bytes], known_names: list[str]) -> dict:
    """Extract date + received line items from a historical purchase/delivery slip.

    Returns {"date", "subtotal", "vat_total", "grand_total", "items": [...], "flags"}.
    Each item: {"raw_text", "matched_ingredient" (name|null), "quantity", "unit",
    "rate", "total_amount", "sd_rate", "sd_amount", "vat_rate", "vat_amount",
    "line_total", "unit_price", "flags"}.
    """
    return verify_and_correct(extract_historic_stock_in_vision(images, known_names))


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
