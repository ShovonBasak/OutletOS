from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ExtractedLine:
    raw_text: str
    extracted_quantity: float | None
    ingredient_id: int | None = None
    pack_definition_id: int | None = None
    unit_captured: str = "PACK"
    rate: float | None = None
    total_amount: float | None = None
    sd_rate: float | None = None
    sd_amount: float | None = None
    vat_rate: float | None = None
    vat_amount: float | None = None
    line_total: float | None = None
    unit_price: float | None = None
