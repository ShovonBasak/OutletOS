"""ProductMatcher — fuzzy-match OCR product names against a known catalog.

Uses RapidFuzz for fast string similarity. The matcher is stateless given the
same catalog, so it can be shared across requests.
"""
from __future__ import annotations

from typing import Optional


class ProductMatcher:
    """Match OCR-extracted product names to known catalog entries.

    Args:
        catalog:   List of canonical product name strings.
        min_score: Minimum similarity score (0–100) to accept a match.
                   Below this threshold, no match is returned.

    Usage::

        matcher = ProductMatcher(["Chicken Pop Stick FPP Chilled", "Burger Bun"])
        name, score = matcher.match("Chicken Pop Stck")
        # → ("Chicken Pop Stick FPP Chilled", 91.4)
    """

    def __init__(self, catalog: list[str], min_score: float = 60.0) -> None:
        self._catalog = list(catalog)
        self._min_score = min_score

    @property
    def catalog(self) -> list[str]:
        return self._catalog

    def match(self, ocr_name: str) -> tuple[str, float]:
        """Return (best_match, score).

        If the catalog is empty or no entry scores above min_score, returns
        ("", 0.0) so callers can distinguish a low-confidence match from
        "no catalog given".
        """
        if not ocr_name or not self._catalog:
            return ("", 0.0)

        try:
            from rapidfuzz import process, fuzz
        except ImportError as exc:
            raise ImportError(
                "rapidfuzz is required for product matching. "
                "Run: pip install rapidfuzz"
            ) from exc

        result = process.extractOne(
            ocr_name,
            self._catalog,
            scorer=fuzz.token_sort_ratio,
            score_cutoff=self._min_score,
        )

        if result is None:
            return ("", 0.0)

        matched_name, score, _ = result
        return (matched_name, float(score))

    def match_all(self, names: list[str]) -> list[tuple[str, float]]:
        """Convenience method to match a batch of names."""
        return [self.match(name) for name in names]
