"""Admin-only service: create historic StockIn and PrepLog records.

Bypasses the normal OperatingDay gate because these are backdated records
entered by an admin — the operating day may not exist and we don't want to
enforce the daily staff flow for historical data entry.

Stock adjustments are applied immediately on import:
  - Stock-in:  RawStock.adjust(+), PackDefinition cost price-versioned if changed
  - Prep log (FRESH): RawStock.adjust(-) per Recipe + DisplayStock.adjust(+)
  - Prep log (CARRIED_FORWARD): DisplayStock.adjust(+) only
"""
from __future__ import annotations

from datetime import date as date_type, datetime, time
from decimal import Decimal

from django.utils import timezone

from catalog.models import Ingredient, PackDefinition, Product
from .models import (
    DisplayStock,
    LineSource,
    PrepSource,
    PrepUnit,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
    StockInStatus,
    UnitCaptured,
)
from .services import consume_for_preparation


def _decimal_or_none(val) -> Decimal | None:
    if val is None or str(val).strip() in ("", "None"):
        return None
    try:
        d = Decimal(str(val))
        return d if d > 0 else None
    except Exception:
        return None


def update_pack_definition_cost(
    pack_id: int,
    new_cost: Decimal,
    slip_date: date_type,
) -> bool:
    """Price-version a PackDefinition if the slip shows a changed cost.

    Closes the current active record (sets effective_to = slip_date) and opens a
    new one with the new cost. Returns True if the PackDefinition was updated.
    """
    try:
        pack = PackDefinition.objects.get(pk=pack_id, effective_to__isnull=True)
    except PackDefinition.DoesNotExist:
        return False

    new_cost = new_cost.quantize(Decimal("0.01"))
    if pack.cost_per_pack == new_cost:
        return False

    pack.effective_to = slip_date
    pack.save(update_fields=["effective_to"])
    PackDefinition.objects.create(
        ingredient=pack.ingredient,
        pieces_per_pack=pack.pieces_per_pack,
        cost_per_pack=new_cost,
        effective_from=slip_date,
        effective_to=None,
    )
    return True


def _effective_cost_per_pack(
    unit_price: Decimal | None,
    line_total: Decimal | None,
    qty: Decimal,
) -> Decimal | None:
    """Compute after-tax cost per pack from slip data.

    Prefers line_total / qty (after-tax) over unit_price (pre-tax).
    Returns None if no usable price data.
    """
    if line_total and qty:
        return (line_total / qty).quantize(Decimal("0.01"))
    if unit_price:
        return unit_price.quantize(Decimal("0.01"))
    return None


def import_stock_in_slip(
    outlet,
    slip_date: date_type,
    items: list[dict],
    admin_user,
    slip_totals: dict | None = None,
    invoice_number: str = "",
) -> tuple[StockInRecord, list[str]]:
    """Create an APPROVED StockInRecord from extracted slip data and adjust RawStock.

    Each item dict expects:
      ingredient_id (int|None), raw_text (str), quantity (str|float),
      unit (PACK|PIECE), pack_definition_id (int|None),
      sku_code (str|None), mrp (str|float|None),
      unit_price (str|float|None), rate (str|float|None),
      total_amount (str|float|None), discount (str|float|None),
      sd_rate (str|float|None), sd_amount (str|float|None),
      vat_rate (str|float|None), vat_amount (str|float|None),
      line_total (str|float|None)

    slip_totals (optional): {"subtotal", "discount_total", "vat_total", "grand_total"} — stored on the record.

    Returns (record, warnings) where warnings lists unresolved lines.
    """
    totals = slip_totals or {}
    record = StockInRecord.objects.create(
        outlet=outlet,
        stock_in_date=slip_date,
        invoice_number=invoice_number or "",
        submitted_by=admin_user,
        status=StockInStatus.APPROVED,
        reviewed_by=admin_user,
        reviewed_at=timezone.now(),
        notes=f"Historic import via admin on {timezone.localdate()}",
        slip_subtotal=_decimal_or_none(totals.get("subtotal")),
        slip_discount_total=_decimal_or_none(totals.get("discount_total")),
        slip_vat_total=_decimal_or_none(totals.get("vat_total")),
        slip_grand_total=_decimal_or_none(totals.get("grand_total")),
    )

    warnings = []
    for item in items:
        ingredient_id = item.get("ingredient_id") or None
        try:
            qty = Decimal(str(item.get("quantity") or "0"))
        except Exception:
            qty = Decimal("0")
        unit     = item.get("unit", UnitCaptured.PACK)
        pack_id  = item.get("pack_definition_id") or None

        sku_code     = item.get("sku_code") or ""
        mrp          = _decimal_or_none(item.get("mrp"))
        unit_price   = _decimal_or_none(item.get("unit_price"))
        rate         = _decimal_or_none(item.get("rate"))
        total_amount = _decimal_or_none(item.get("total_amount"))
        discount     = _decimal_or_none(item.get("discount"))
        sd_rate      = _decimal_or_none(item.get("sd_rate"))
        sd_amount    = _decimal_or_none(item.get("sd_amount"))
        vat_rate     = _decimal_or_none(item.get("vat_rate"))
        vat_amount   = _decimal_or_none(item.get("vat_amount"))
        line_total   = _decimal_or_none(item.get("line_total"))

        # Fallback: derive line_total from rate/qty/discount when not explicit.
        if line_total is None and rate and qty:
            line_total = (rate * qty - (discount or Decimal("0"))).quantize(Decimal("0.01"))

        si_item = StockInItem.objects.create(
            stock_in_record=record,
            ingredient_id=ingredient_id,
            raw_extracted_text=item.get("raw_text", ""),
            source=LineSource.SLIP_EXTRACTED,
            unit_captured=unit,
            extracted_quantity=qty,
            confirmed_quantity=qty,
            pack_definition_id=pack_id,
            sku_code=sku_code,
            mrp=mrp,
            unit_price=unit_price,
            rate=rate,
            total_amount=total_amount,
            discount=discount,
            sd_rate=sd_rate,
            sd_amount=sd_amount,
            vat_rate=vat_rate,
            vat_amount=vat_amount,
            line_total=line_total,
        )

        if ingredient_id:
            delta = si_item.base_unit_quantity()
            if delta:
                ingredient = Ingredient.objects.get(pk=ingredient_id)
                RawStock.adjust(outlet, ingredient, delta)

            # Update PackDefinition cost if this is a PACK line with price data
            if pack_id and unit == UnitCaptured.PACK and qty:
                cost = _effective_cost_per_pack(unit_price, line_total, qty)
                if cost:
                    update_pack_definition_cost(pack_id, cost, slip_date)
        else:
            warnings.append(
                f"Unresolved line '{item.get('raw_text', '')}' — no ingredient mapped; "
                "RawStock not updated for this line."
            )

    return record, warnings


def import_prep_log_slip(
    outlet,
    prep_date: date_type,
    items: list[dict],
    admin_user,
) -> tuple[list[PreparationLog], list[str]]:
    """Create PreparationLog entries from extracted prep-log data.

    Each item dict expects:
      product_id (int|None), raw_text (str), pieces_prepared (int),
      source (FRESH|CARRIED_FORWARD)

    FRESH entries deduct RawStock per Recipe (same as normal preparation).
    Returns (logs, warnings) where warnings lists unresolved or skipped lines.
    """
    # noon on the historic date, timezone-aware
    prep_dt = timezone.make_aware(datetime.combine(prep_date, time(12, 0)))

    logs = []
    warnings = []

    for item in items:
        product_id = item.get("product_id") or None
        if not product_id:
            warnings.append(
                f"Unresolved line '{item.get('raw_text', '')}' — no product mapped; skipped."
            )
            continue

        try:
            pieces = int(item.get("pieces_prepared") or 0)
        except (ValueError, TypeError):
            pieces = 0

        if pieces <= 0:
            continue

        source = item.get("source", PrepSource.FRESH)

        log = PreparationLog.objects.create(
            outlet=outlet,
            logged_by=admin_user,
            product_id=product_id,
            source=source,
            prep_unit=PrepUnit.PIECE,
            pieces_prepared=pieces,
        )
        # Override auto_now_add timestamp to noon on the historic prep date.
        PreparationLog.objects.filter(pk=log.pk).update(timestamp=prep_dt)

        if source == PrepSource.FRESH:
            try:
                product = Product.objects.get(pk=product_id)
                consume_for_preparation(outlet, product, pieces)
            except Product.DoesNotExist:
                warnings.append(f"Product id={product_id} not found; RawStock not deducted.")

        try:
            product = Product.objects.get(pk=product_id)
            DisplayStock.adjust(outlet, product, pieces)
        except Product.DoesNotExist:
            pass

        logs.append(log)

    return logs, warnings
