"""Dataclass schemas for Invoice OCR output."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class InvoiceItem:
    """A single line item extracted from the invoice table."""

    product_name: str
    """Raw name from OCR — not cleaned or corrected."""

    matched_product: str
    """Best-matching name from the product catalog (empty string if no catalog given)."""

    match_score: float
    """RapidFuzz similarity score 0–100. 0 means no catalog was provided."""

    quantity: Optional[float]
    unit: str                    # e.g. "PACK", "PIECE", "Kg"
    unit_price: Optional[float]              # effective cost per unit = line_total ÷ qty
    sku_code: Optional[str] = None          # supplier product code (পণ্য কোড)
    mrp: Optional[float] = None             # MRP per piece (beverages)
    rate: Optional[float] = None            # pre-discount, pre-tax rate per pack/unit
    amount: Optional[float] = None          # pre-discount subtotal = qty × rate
    discount: Optional[float] = None        # per-line discount amount (beverages)
    sd_rate: Optional[float] = None         # Supplementary Duty %
    sd_amount: Optional[float] = None       # Supplementary Duty amount
    vat_rate: Optional[float] = None        # VAT % (e.g. 15.0 for 15%)
    vat: Optional[float] = None             # VAT amount
    total: Optional[float] = None           # final net total (after discount + SD + VAT)

    is_flagged: bool = False
    """True when a validation rule fires for this item."""

    flag_reason: str = ""
    """Human-readable reason for the flag."""


@dataclass
class InvoiceSummary:
    """Slip-level financial totals."""

    subtotal: Optional[float]         # sum of all line amounts before discount/VAT
    discount_total: Optional[float]   # total discount (beverages: মোট ডিসকাউন্ট)
    vat: Optional[float]              # total VAT
    grand_total: Optional[float]      # final payable amount


@dataclass
class InvoiceOCRResult:
    """Full result returned by extract_invoice()."""

    invoice_number: str
    invoice_date: str            # ISO "YYYY-MM-DD", or empty string
    supplier: str
    customer: str

    items: list[InvoiceItem]
    summary: InvoiceSummary
    warnings: list[str]
    """Non-fatal issues found during validation (math mismatches, low match scores, etc.)."""

    def to_dict(self) -> dict:
        """Serialise to the documented JSON output shape."""
        return {
            "invoice_number": self.invoice_number,
            "invoice_date": self.invoice_date,
            "supplier": self.supplier,
            "customer": self.customer,
            "items": [
                {
                    "product_name": it.product_name,
                    "matched_product": it.matched_product,
                    "match_score": round(it.match_score, 2),
                    "quantity": it.quantity,
                    "unit": it.unit,
                    "unit_price": it.unit_price,
                    "sku_code": it.sku_code,
                    "mrp": it.mrp,
                    "rate": it.rate,
                    "amount": it.amount,
                    "discount": it.discount,
                    "sd_rate": it.sd_rate,
                    "sd_amount": it.sd_amount,
                    "vat_rate": it.vat_rate,
                    "vat": it.vat,
                    "total": it.total,
                    "is_flagged": it.is_flagged,
                    "flag_reason": it.flag_reason,
                }
                for it in self.items
            ],
            "summary": {
                "subtotal": self.summary.subtotal,
                "discount_total": self.summary.discount_total,
                "vat": self.summary.vat,
                "grand_total": self.summary.grand_total,
            },
            "warnings": self.warnings,
        }
