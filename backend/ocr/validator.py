"""InvoiceValidator — validation rules for extracted invoice data.

Rules never silently modify values; they only flag suspicious rows and return
human-readable warning strings.
"""
from __future__ import annotations

from .schemas import InvoiceItem, InvoiceSummary, InvoiceOCRResult


class InvoiceValidator:
    """Validate an InvoiceOCRResult and return a list of warning strings.

    Mutates ``item.is_flagged`` and ``item.flag_reason`` for per-item issues.
    Appends summary-level issues to the returned warning list without touching items.

    Args:
        tolerance:     Fractional tolerance for math checks (default 5%).
        min_match_score: Warn when a product's fuzzy-match score is below this.
    """

    def __init__(
        self,
        tolerance: float = 0.05,
        min_match_score: float = 70.0,
    ) -> None:
        self.tolerance = tolerance
        self.min_match_score = min_match_score

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def validate(self, result: InvoiceOCRResult) -> list[str]:
        """Run all validation rules.

        Returns:
            List of warning strings (empty = no issues).
        """
        warnings: list[str] = []
        warnings.extend(self._validate_items(result.items))
        warnings.extend(self._validate_summary(result.items, result.summary))
        warnings.extend(self._validate_match_scores(result.items))
        return warnings

    # ------------------------------------------------------------------
    # Per-item rules
    # ------------------------------------------------------------------

    def _validate_items(self, items: list[InvoiceItem]) -> list[str]:
        warnings: list[str] = []
        for i, item in enumerate(items, start=1):
            label = f'Row {i} "{item.product_name}"'
            row_warns: list[str] = []

            # Rule 1: rate × qty ≈ amount (pre-tax subtotal check)
            if item.rate is not None and item.quantity is not None and item.amount is not None:
                expected = item.rate * item.quantity
                if not _approx_equal(expected, item.amount, self.tolerance):
                    row_warns.append(
                        f"{label}: rate×qty ({expected:.2f}) ≠ amount ({item.amount:.2f})"
                    )

            # Rule 1b: unit_price × qty ≈ total (after-tax check)
            if item.unit_price is not None and item.quantity is not None and item.total is not None:
                expected = item.unit_price * item.quantity
                if not _approx_equal(expected, item.total, self.tolerance):
                    row_warns.append(
                        f"{label}: unit_price×qty ({expected:.2f}) ≠ total ({item.total:.2f})"
                    )

            # Rule 2: amount + vat ≈ total
            if item.amount is not None and item.vat is not None and item.total is not None:
                expected = item.amount + item.vat
                if not _approx_equal(expected, item.total, self.tolerance):
                    row_warns.append(
                        f"{label}: amount+vat ({expected:.2f}) ≠ total ({item.total:.2f})"
                    )

            # Rule 3: quantity must be positive
            if item.quantity is not None and item.quantity <= 0:
                row_warns.append(f"{label}: quantity is zero or negative ({item.quantity})")

            # Rule 4: unit_price must be positive
            if item.unit_price is not None and item.unit_price <= 0:
                row_warns.append(f"{label}: unit_price is zero or negative ({item.unit_price})")

            if row_warns:
                item.is_flagged = True
                item.flag_reason = "; ".join(row_warns)
                warnings.extend(row_warns)

        return warnings

    # ------------------------------------------------------------------
    # Summary-level rules
    # ------------------------------------------------------------------

    def _validate_summary(
        self,
        items: list[InvoiceItem],
        summary: InvoiceSummary,
    ) -> list[str]:
        warnings: list[str] = []

        # Rule 5: subtotal + vat ≈ grand_total
        if (
            summary.subtotal is not None
            and summary.vat is not None
            and summary.grand_total is not None
        ):
            expected = summary.subtotal + summary.vat
            if not _approx_equal(expected, summary.grand_total, self.tolerance):
                warnings.append(
                    f"Summary: subtotal+vat ({expected:.2f}) ≠ grand_total ({summary.grand_total:.2f})"
                )

        # Rule 6: sum of item totals ≈ grand_total
        item_totals = [it.total for it in items if it.total is not None]
        if item_totals and summary.grand_total is not None:
            total_sum = sum(item_totals)
            if not _approx_equal(total_sum, summary.grand_total, self.tolerance):
                warnings.append(
                    f"Summary: sum of line totals ({total_sum:.2f}) ≠ "
                    f"grand_total ({summary.grand_total:.2f})"
                )

        # Rule 7: sum of item amounts ≈ subtotal
        item_amounts = [it.amount for it in items if it.amount is not None]
        if item_amounts and summary.subtotal is not None:
            amount_sum = sum(item_amounts)
            if not _approx_equal(amount_sum, summary.subtotal, self.tolerance):
                warnings.append(
                    f"Summary: sum of line amounts ({amount_sum:.2f}) ≠ "
                    f"subtotal ({summary.subtotal:.2f})"
                )

        return warnings

    # ------------------------------------------------------------------
    # Match score rules
    # ------------------------------------------------------------------

    def _validate_match_scores(self, items: list[InvoiceItem]) -> list[str]:
        warnings: list[str] = []
        for i, item in enumerate(items, start=1):
            if item.matched_product and item.match_score < self.min_match_score:
                warnings.append(
                    f'Row {i} "{item.product_name}": low match confidence '
                    f'({item.match_score:.1f}%) → "{item.matched_product}"'
                )
        return warnings


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _approx_equal(a: float, b: float, tolerance: float) -> bool:
    """True when a and b agree within the given fractional tolerance."""
    if b == 0:
        return abs(a) < 1e-6
    return abs(a - b) / abs(b) <= tolerance
