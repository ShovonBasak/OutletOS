"""
Catalog entity resolution for PaddleOCR-extracted text.

Resolution order for a raw ingredient name:
  1. Exact alias match     (SupplierProductAlias)
  2. Substring / token-overlap alias match (≥60 % overlap)
  3. Exact ingredient name match
  4. Substring / token-overlap ingredient name match

Also provides name-suggestion helpers used by the ingredient-setup flow.
"""
from __future__ import annotations

import re


def _norm(text: str) -> str:
    """Lower-case, strip punctuation, collapse whitespace."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _overlap(a_tokens: set[str], b_tokens: set[str]) -> float:
    if not b_tokens:
        return 0.0
    return len(a_tokens & b_tokens) / len(b_tokens)


def resolve_ingredient(raw_text: str) -> tuple[int | None, int | None]:
    """Return (ingredient_id, pack_definition_id) for *raw_text*.

    Performs four-level lookup (exact alias → fuzzy alias → exact name →
    fuzzy name).  Returns (None, None) if nothing reaches the 60 % threshold.
    """
    from catalog.models import Ingredient, SupplierProductAlias

    norm = _norm(raw_text)
    if not norm:
        return None, None
    norm_toks = set(norm.split())

    best_ing = None
    best_score = 0.0

    # ── Alias pass ──────────────────────────────────────────────────────────
    for alias in (
        SupplierProductAlias.objects
        .filter(is_active=True)
        .select_related("ingredient")
    ):
        a = _norm(alias.alias_text)
        if not a:
            continue
        if a == norm or a in norm or norm in a:
            ing = alias.ingredient
            pack = ing.pack_definitions.filter(effective_to__isnull=True).first()
            return ing.pk, (pack.pk if pack else None)
        score = _overlap(norm_toks, set(a.split()))
        if score > best_score:
            best_score = score
            best_ing = alias.ingredient

    if best_score >= 0.6 and best_ing:
        pack = best_ing.pack_definitions.filter(effective_to__isnull=True).first()
        return best_ing.pk, (pack.pk if pack else None)

    # ── Ingredient name pass ─────────────────────────────────────────────────
    best_ing = None
    best_score = 0.0
    for ing in Ingredient.objects.filter(is_active=True):
        a = _norm(ing.name)
        if a == norm or a in norm or norm in a:
            pack = ing.pack_definitions.filter(effective_to__isnull=True).first()
            return ing.pk, (pack.pk if pack else None)
        score = _overlap(norm_toks, set(a.split()))
        if score > best_score:
            best_score = score
            best_ing = ing

    if best_score >= 0.6 and best_ing:
        pack = best_ing.pack_definitions.filter(effective_to__isnull=True).first()
        return best_ing.pk, (pack.pk if pack else None)

    return None, None


# ---------------------------------------------------------------------------
# Name / unit suggestion helpers (used by ingredient-setup flow)
# ---------------------------------------------------------------------------

_PACK_SIZE_RE = re.compile(
    r"\b\d+\s*(pc|pcs|pieces|ltr|l|ml|oz|kg|gm|gms|g|btl|bottle|bag|pkt|packet|pack|box|ctn|carton)\b",
    re.I,
)
_PACK_PIECES_RE = re.compile(r"(\d+)\s*(?:pc|pcs|pieces)\b", re.I)
_TRAILING_PRICE_RE = re.compile(r"\s*[\d,]+\.\d{2}\s*")
_LEADING_SL_RE = re.compile(r"^\d{1,2}[.)]\s*")


def suggest_clean_name(raw: str) -> str:
    """Remove slip artefacts (serial number, pack-size tokens, price columns)
    and title-case the result to produce a candidate internal ingredient name.
    """
    s = _LEADING_SL_RE.sub("", raw)
    s = _PACK_SIZE_RE.sub("", s)
    s = _TRAILING_PRICE_RE.sub(" ", s)
    s = re.sub(r"[^A-Za-z0-9 /]+", " ", s)
    s = re.sub(r"\b\d+\b", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.title() if s else raw.strip().title()


def suggest_unit(raw: str) -> str:
    """Guess a recipe-friendly base unit from the raw slip text."""
    low = raw.lower()
    if re.search(r"\b(ml|ltr|\dl\b|bottle|btl)\b", low):
        return "portion"
    return "piece"


def suggest_pack_pieces(raw: str) -> float | None:
    """Extract pack yield from a name like 'Chicken Patty 10pc' → 10."""
    m = _PACK_PIECES_RE.search(raw)
    return float(m.group(1)) if m else None
