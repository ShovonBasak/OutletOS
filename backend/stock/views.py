from decimal import Decimal

from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from accounts.permissions import IsOwner
from catalog.models import Ingredient, SupplierProductAlias, TrackingMode
from .extraction import OcrUnavailable, extract_from_slip
from .models import (
    DayStartStockCheck,
    DisplayStock,
    LineSource,
    OperatingDay,
    OperatingDayStatus,
    PeriodicStockCheck,
    PrepSource,
    PrepUnit,
    PreparationLog,
    RawStock,
    StockInItem,
    StockInRecord,
    StockInStatus,
    UnitCaptured,
)
from .serializers import (
    DayStartStockCheckSerializer,
    DisplayStockSerializer,
    OperatingDaySerializer,
    PeriodicStockCheckSerializer,
    PreparationLogSerializer,
    RawStockSerializer,
    StockInRecordSerializer,
)
from .services import (
    carry_forward_candidates,
    consume_for_preparation,
    get_or_create_today,
    stock_in_since,
)


class StockInRecordViewSet(viewsets.ModelViewSet):
    queryset = StockInRecord.objects.prefetch_related("items__ingredient").select_related(
        "outlet", "submitted_by"
    )
    serializer_class = StockInRecordSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        status_param = self.request.query_params.get("status")
        if status_param:
            qs = qs.filter(status=status_param)
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        return qs

    def perform_create(self, serializer):
        serializer.save(submitted_by=self.request.user)

    def _guard_editable(self, record):
        if record.status not in (StockInStatus.DRAFT,):
            raise ValidationError("Only DRAFT records can be edited by staff.")

    def update(self, request, *args, **kwargs):
        self._guard_editable(self.get_object())
        return super().update(request, *args, **kwargs)

    @action(
        detail=True,
        methods=["post"],
        url_path="upload-slip",
        parser_classes=[MultiPartParser, FormParser],
    )
    def upload_slip(self, request, pk=None):
        """Attach/replace the delivery-slip image (multipart field `slip_image`)."""
        record = self.get_object()
        self._guard_editable(record)
        image = request.FILES.get("slip_image")
        if not image:
            raise ValidationError("No slip_image file provided.")
        record.slip_image = image
        record.save(update_fields=["slip_image"])
        return Response(self.get_serializer(record).data)

    @action(detail=True, methods=["post"])
    def extract(self, request, pk=None):
        """OCR the attached slip → create/refresh SLIP_EXTRACTED lines.

        Tries Claude vision first; falls back to Tesseract if unavailable.
        Unmatched lines become 'Unrecognized' rows (ingredient=None) for staff to
        resolve. Existing slip-extracted lines are replaced; manual lines kept.
        """
        from .extraction import ExtractedLine

        record = self.get_object()
        self._guard_editable(record)
        if not record.slip_image:
            raise ValidationError("Attach a slip image before extracting.")

        lines = None

        # ── Claude LLM path ──────────────────────────────────────────────────
        try:
            from catalog import ai_extraction

            known_names = list(
                Ingredient.objects.filter(is_active=True).values_list("name", flat=True)
            )
            with open(record.slip_image.path, "rb") as fh:
                image_data = fh.read()

            llm_items = ai_extraction.extract_stock_in([image_data], known_names)
            lines = []
            for item in llm_items:
                matched_name = item.get("matched_ingredient")
                ingredient_id = None
                pack_definition_id = None
                if matched_name:
                    ing = Ingredient.objects.filter(name=matched_name, is_active=True).first()
                    if ing:
                        ingredient_id = ing.id
                        pack = ing.pack_definitions.filter(effective_to__isnull=True).first()
                        pack_definition_id = pack.id if pack else None
                qty = item.get("quantity")
                lines.append(ExtractedLine(
                    raw_text=item.get("raw_text", ""),
                    extracted_quantity=float(qty) if qty is not None else None,
                    ingredient_id=ingredient_id,
                    pack_definition_id=pack_definition_id,
                    unit_captured=item.get("unit", "PACK"),
                ))
        except Exception:  # noqa: BLE001 — LLMUnavailable or any API error → fall back
            lines = None

        # ── Tesseract fallback ───────────────────────────────────────────────
        if lines is None:
            try:
                lines = extract_from_slip(record.slip_image.path)
            except OcrUnavailable as exc:
                return Response(
                    {
                        "detail": "OCR is unavailable — please enter lines manually.",
                        "reason": str(exc),
                        "ocr_available": False,
                    },
                    status=503,
                )

        record.items.filter(source=LineSource.SLIP_EXTRACTED).delete()
        for line in lines:
            StockInItem.objects.create(
                stock_in_record=record,
                ingredient_id=line.ingredient_id,
                pack_definition_id=line.pack_definition_id,
                raw_extracted_text=line.raw_text,
                source=LineSource.SLIP_EXTRACTED,
                unit_captured=line.unit_captured,
                extracted_quantity=line.extracted_quantity,
                confirmed_quantity=line.extracted_quantity or Decimal("0"),
            )
        record = self.get_queryset().get(pk=record.pk)
        data = self.get_serializer(record).data
        data["extracted_count"] = len(lines)
        return Response(data)

    @action(detail=True, methods=["post"], url_path="resolve-line")
    def resolve_line(self, request, pk=None):
        """Resolve an Unrecognized line: assign an ingredient (existing or new)
        and remember the mapping as a SupplierProductAlias for next time.
        Body: {item, ingredient?|new_ingredient_name?, base_unit?, pack_definition?}."""
        record = self.get_object()
        self._guard_editable(record)
        item = record.items.get(pk=request.data["item"])

        ingredient_id = request.data.get("ingredient")
        if ingredient_id:
            ingredient = Ingredient.objects.get(pk=ingredient_id)
        else:
            name = (request.data.get("new_ingredient_name") or "").strip()
            if not name:
                raise ValidationError("Provide ingredient or new_ingredient_name.")
            ingredient, _ = Ingredient.objects.get_or_create(
                name=name,
                defaults={"base_unit": request.data.get("base_unit", "piece")},
            )
        item.ingredient = ingredient
        pack_definition_id = request.data.get("pack_definition")
        if pack_definition_id:
            item.pack_definition_id = pack_definition_id
        else:
            active = ingredient.active_pack()
            item.pack_definition = active
        item.save()

        # Remember the supplier wording so it auto-resolves next time.
        if item.raw_extracted_text:
            SupplierProductAlias.objects.get_or_create(
                ingredient=ingredient, alias_text=item.raw_extracted_text
            )
        record = self.get_queryset().get(pk=record.pk)
        return Response(self.get_serializer(record).data)

    @action(detail=True, methods=["post"], url_path="set-pack-yield")
    def set_pack_yield(self, request, pk=None):
        """Answer the inline 'how many pieces does 1 pack make?' prompt — creates
        the ingredient's first PackDefinition on the spot. Body:
        {item, pieces_per_pack, cost_per_pack}."""
        from catalog.models import PackDefinition

        record = self.get_object()
        self._guard_editable(record)
        item = record.items.get(pk=request.data["item"])
        if not item.ingredient_id:
            raise ValidationError("Resolve the ingredient before setting pack yield.")
        pack = PackDefinition.objects.create(
            ingredient=item.ingredient,
            pieces_per_pack=Decimal(str(request.data["pieces_per_pack"])),
            cost_per_pack=Decimal(str(request.data.get("cost_per_pack", 0))),
            effective_from=timezone.localdate(),
        )
        item.pack_definition = pack
        item.save(update_fields=["pack_definition"])
        record = self.get_queryset().get(pk=record.pk)
        return Response(self.get_serializer(record).data)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        """Staff moves DRAFT → PENDING. Blocked if any line is unresolved."""
        record = self.get_object()
        if record.status != StockInStatus.DRAFT:
            raise ValidationError("Only DRAFT records can be submitted.")
        unresolved = record.unresolved_lines
        if unresolved:
            raise ValidationError(
                {
                    "detail": "Resolve all lines before submitting "
                    "(unknown ingredient or missing pack yield).",
                    "unresolved_item_ids": [i.id for i in unresolved],
                }
            )
        record.status = StockInStatus.PENDING
        record.save()
        return Response(self.get_serializer(record).data)

    @action(detail=True, methods=["post"], permission_classes=[IsOwner])
    def approve(self, request, pk=None):
        """Owner approves PENDING → APPROVED; RawStock increments (base units)."""
        record = self.get_object()
        if record.status != StockInStatus.PENDING:
            raise ValidationError("Only PENDING records can be approved.")
        for item in record.items.select_related("ingredient", "pack_definition"):
            if not item.ingredient_id:
                continue
            RawStock.adjust(record.outlet, item.ingredient, item.base_unit_quantity())
        record.status = StockInStatus.APPROVED
        record.reviewed_by = request.user
        record.reviewed_at = timezone.now()
        record.save()
        return Response(self.get_serializer(record).data)

    @action(detail=True, methods=["post"], permission_classes=[IsOwner])
    def reject(self, request, pk=None):
        record = self.get_object()
        if record.status != StockInStatus.PENDING:
            raise ValidationError("Only PENDING records can be rejected.")
        record.status = StockInStatus.REJECTED
        record.reviewed_by = request.user
        record.reviewed_at = timezone.now()
        record.notes = request.data.get("notes", record.notes)
        record.save()
        return Response(self.get_serializer(record).data)


class PreparationLogViewSet(viewsets.ModelViewSet):
    queryset = PreparationLog.objects.select_related("product", "outlet")
    serializer_class = PreparationLogSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        if self.request.query_params.get("today") == "true":
            qs = qs.filter(timestamp__date=timezone.localdate())
        return qs

    def perform_create(self, serializer):
        data = serializer.validated_data
        product = data["product"]
        outlet = data["outlet"]
        source = data.get("source", PrepSource.FRESH)

        if source == PrepSource.CARRIED_FORWARD:
            leftover = int(data.get("leftover_available_pieces") or 0)
            pieces = int(data.get("pieces_prepared") or leftover)
            pieces = min(pieces, leftover) if leftover else pieces
            wastage = max(0, leftover - pieces)
            instance = serializer.save(
                logged_by=self.request.user,
                pieces_prepared=pieces,
                wastage_pieces=wastage,
                leftover_available_pieces=leftover,
            )
            DisplayStock.adjust(outlet, product, pieces)
            return instance

        # FRESH
        unit = data.get("prep_unit", PrepUnit.PIECE)
        recipes = list(product.recipes.select_related("ingredient"))
        if unit == PrepUnit.PACK:
            if len(recipes) != 1:
                raise ValidationError(
                    "PACK entry is only valid for a single-ingredient recipe; "
                    "use PIECE and log finished units."
                )
            packs_used = Decimal(str(data["packs_used"]))
            pack = recipes[0].ingredient.active_pack()
            if not pack:
                raise ValidationError("No active pack definition for the recipe ingredient.")
            base_units = packs_used * pack.pieces_per_pack
            pieces = int(base_units / (recipes[0].quantity_per_unit or Decimal("1")))
            instance = serializer.save(
                logged_by=self.request.user, pieces_prepared=pieces
            )
            RawStock.adjust(outlet, recipes[0].ingredient, -base_units)
        else:  # PIECE
            pieces = int(data["pieces_prepared"])
            instance = serializer.save(logged_by=self.request.user, pieces_prepared=pieces)
            consume_for_preparation(outlet, product, pieces)

        DisplayStock.adjust(outlet, product, pieces)
        return instance


class RawStockViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = RawStock.objects.select_related("ingredient", "outlet")
    serializer_class = RawStockSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        return qs


class DisplayStockViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = DisplayStock.objects.select_related("product", "outlet")
    serializer_class = DisplayStockSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        return qs


class OperatingDayViewSet(viewsets.ReadOnlyModelViewSet):
    """Gates the staff daily flow. Read + custom transitions (start, confirm)."""

    queryset = OperatingDay.objects.select_related("outlet", "started_by")
    serializer_class = OperatingDaySerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        date = self.request.query_params.get("date")
        if date:
            qs = qs.filter(date=date)
        return qs

    def _outlet(self, request):
        outlet_id = request.data.get("outlet") or request.query_params.get("outlet")
        if outlet_id:
            from catalog.models import Outlet

            return Outlet.objects.get(pk=outlet_id)
        return request.user.outlet

    @action(detail=False, methods=["get", "post"])
    def today(self, request):
        """Get (or lazily create) today's OperatingDay for the outlet."""
        day = get_or_create_today(self._outlet(request))
        return Response(self.get_serializer(day).data)

    @action(detail=True, methods=["post"])
    def start(self, request, pk=None):
        day = self.get_object()
        if day.status == OperatingDayStatus.NOT_STARTED:
            day.status = OperatingDayStatus.NOT_STARTED  # stays; stock check advances it
            day.started_by = request.user
            day.started_at = timezone.now()
            day.save()
        return Response(self.get_serializer(day).data)

    @action(detail=True, methods=["get"], url_path="day-start-stock")
    def day_start_stock(self, request, pk=None):
        """Rows to reconcile: every RECIPE_LINKED ingredient with its carried
        RawStock balance, merged with any already-saved confirmations."""
        day = self.get_object()
        existing = {c.ingredient_id: c for c in day.stock_checks.select_related("ingredient")}
        rows = []
        ingredients = Ingredient.objects.filter(
            is_active=True, tracking_mode=TrackingMode.RECIPE_LINKED
        )
        for ing in ingredients:
            rs = RawStock.objects.filter(outlet=day.outlet, ingredient=ing).first()
            carried = rs.quantity_available if rs else Decimal("0")
            check = existing.get(ing.id)
            rows.append(
                {
                    "ingredient": ing.id,
                    "ingredient_name": ing.name,
                    "base_unit": ing.base_unit,
                    "system_carried_qty": carried,
                    "confirmed_qty": check.confirmed_qty if check else carried,
                    "discrepancy_reason": check.discrepancy_reason if check else "",
                    "note": check.note if check else "",
                }
            )
        return Response(rows)

    @action(detail=True, methods=["post"], url_path="confirm-stock")
    def confirm_stock(self, request, pk=None):
        """Save DayStartStockCheck rows, set RawStock to confirmed values, advance
        to STOCK_CONFIRMED. Any discrepancy needs a reason. Body: {items:[...]}."""
        day = self.get_object()
        for row in request.data.get("items", []):
            ing = Ingredient.objects.get(pk=row["ingredient"])
            system = Decimal(str(row["system_carried_qty"]))
            confirmed = Decimal(str(row["confirmed_qty"]))
            reason = row.get("discrepancy_reason", "")
            if system != confirmed and not reason:
                raise ValidationError(
                    f"'{ing.name}' has a discrepancy — a reason is required."
                )
            obj, _ = DayStartStockCheck.objects.get_or_create(
                operating_day=day, ingredient=ing
            )
            obj.system_carried_qty = system
            obj.confirmed_qty = confirmed
            obj.discrepancy_reason = reason
            obj.note = row.get("note", "")
            obj.save()
            RawStock.set_to(day.outlet, ing, confirmed)
        if day.status == OperatingDayStatus.NOT_STARTED:
            day.status = OperatingDayStatus.STOCK_CONFIRMED
        day.stock_confirmed_at = timezone.now()
        if not day.started_at:
            day.started_by = request.user
            day.started_at = timezone.now()
        day.save()
        return Response(self.get_serializer(day).data)

    @action(detail=True, methods=["get"], url_path="carry-forward")
    def carry_forward_list(self, request, pk=None):
        """Yesterday's leftovers to move into today's display stock."""
        day = self.get_object()
        rows = []
        for count in carry_forward_candidates(day):
            rows.append(
                {
                    "stock_count": count.id,
                    "product": count.product_id,
                    "product_name": count.product.name,
                    "leftover_available_pieces": count.remains_pieces,
                    "pieces_prepared": count.remains_pieces,
                }
            )
        return Response(rows)

    @action(detail=True, methods=["post"], url_path="confirm-carry-forward")
    def confirm_carry_forward(self, request, pk=None):
        """Create CARRIED_FORWARD PreparationLog rows (no RawStock change) and
        advance to IN_PROGRESS. Partial moves auto-fill wastage. Body:{items:[...]}."""
        from closing.models import DailyClosingStockCount

        day = self.get_object()
        if day.status == OperatingDayStatus.NOT_STARTED:
            raise ValidationError("Confirm day-start stock first.")
        for row in request.data.get("items", []):
            count = DailyClosingStockCount.objects.get(pk=row["stock_count"])
            leftover = int(row.get("leftover_available_pieces", count.remains_pieces))
            pieces = int(row.get("pieces_prepared", leftover))
            pieces = max(0, min(pieces, leftover))
            wastage = leftover - pieces
            PreparationLog.objects.create(
                outlet=day.outlet,
                logged_by=request.user,
                product=count.product,
                source=PrepSource.CARRIED_FORWARD,
                carried_forward_from=count,
                leftover_available_pieces=leftover,
                pieces_prepared=pieces,
                wastage_pieces=wastage,
            )
            if pieces:
                DisplayStock.adjust(day.outlet, count.product, pieces)
        day.status = OperatingDayStatus.IN_PROGRESS
        day.carry_forward_confirmed_at = timezone.now()
        day.save()
        return Response(self.get_serializer(day).data)


class PeriodicStockCheckViewSet(viewsets.ModelViewSet):
    """Packaging & supplies — staff reports what's left; consumption is inferred."""

    queryset = PeriodicStockCheck.objects.select_related("ingredient", "outlet", "checked_by")
    serializer_class = PeriodicStockCheckSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        ingredient = self.request.query_params.get("ingredient")
        if ingredient:
            qs = qs.filter(ingredient_id=ingredient)
        if self.request.query_params.get("latest_per_ingredient") == "true":
            # Keep only the newest row per ingredient (small dataset — do it in py).
            seen, keep = set(), []
            for row in qs:
                if row.ingredient_id in seen:
                    continue
                seen.add(row.ingredient_id)
                keep.append(row.id)
            qs = qs.filter(id__in=keep)
        return qs

    def _record(self, outlet, ingredient, counted_qty, note, user):
        prev = (
            PeriodicStockCheck.objects.filter(outlet=outlet, ingredient=ingredient)
            .order_by("-checked_at")
            .first()
        )
        since = prev.checked_at if prev else None
        stock_in = stock_in_since(outlet, ingredient, since) if since else Decimal("0")
        prev_qty = prev.counted_qty if prev else Decimal("0")
        consumed = prev_qty + stock_in - counted_qty
        return PeriodicStockCheck.objects.create(
            outlet=outlet,
            ingredient=ingredient,
            checked_by=user,
            counted_qty=counted_qty,
            stock_in_since_last_check=stock_in,
            consumed_since_last_check=consumed,
            note=note,
        )

    def create(self, request, *args, **kwargs):
        """Full recount. Body: {outlet, ingredient, counted_qty, note?}."""
        ingredient = Ingredient.objects.get(pk=request.data["ingredient"])
        outlet = _outlet_obj(request.data.get("outlet") or request.user.outlet_id)
        obj = self._record(
            outlet,
            ingredient,
            Decimal(str(request.data["counted_qty"])),
            request.data.get("note", ""),
            request.user,
        )
        return Response(self.get_serializer(obj).data, status=201)

    @action(detail=False, methods=["post"], url_path="bundle-finished")
    def bundle_finished(self, request, pk=None):
        """One-tap 'used the last of a bundle' — subtracts the pack size from the
        last count. Body: {outlet, ingredient}."""
        ingredient = Ingredient.objects.get(pk=request.data["ingredient"])
        outlet = _outlet_obj(request.data.get("outlet") or request.user.outlet_id)
        prev = (
            PeriodicStockCheck.objects.filter(outlet=outlet, ingredient=ingredient)
            .order_by("-checked_at")
            .first()
        )
        pack = ingredient.active_pack()
        bundle = pack.pieces_per_pack if pack else Decimal("0")
        prev_qty = prev.counted_qty if prev else bundle
        counted = max(Decimal("0"), prev_qty - bundle)
        obj = self._record(
            outlet, ingredient, counted, "Bundle finished (−1 pack)", request.user
        )
        return Response(self.get_serializer(obj).data, status=201)


def _outlet_obj(outlet_or_id):
    from catalog.models import Outlet

    if outlet_or_id is None:
        return None
    if hasattr(outlet_or_id, "pk"):
        return outlet_or_id
    return Outlet.objects.get(pk=outlet_or_id)
