from datetime import timedelta
from decimal import Decimal

from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrReadOnly
from .models import (
    ComboComponent,
    Ingredient,
    Outlet,
    PackDefinition,
    Product,
    ProductPrice,
    Recipe,
    RecipeProductComponent,
    SupplierProductAlias,
)
from .serializers import (
    ComboComponentSerializer,
    IngredientSerializer,
    OutletSerializer,
    PackDefinitionSerializer,
    ProductPriceSerializer,
    ProductSerializer,
    RecipeProductComponentSerializer,
    RecipeSerializer,
    SupplierProductAliasSerializer,
)


class OutletViewSet(viewsets.ModelViewSet):
    queryset = Outlet.objects.all()
    serializer_class = OutletSerializer
    permission_classes = [IsOwnerOrReadOnly]


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all().prefetch_related(
        "components", "recipes__ingredient", "product_recipe_components__component_product"
    )
    serializer_class = ProductSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset().filter(is_active=True)
        ptype = self.request.query_params.get("product_type")
        if ptype:
            qs = qs.filter(product_type=ptype)
        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        as_of_param = self.request.query_params.get("as_of")
        if as_of_param:
            from datetime import date as date_type
            try:
                ctx["as_of"] = date_type.fromisoformat(as_of_param)
            except ValueError:
                pass
        return ctx

    def destroy(self, request, *args, **kwargs):
        product = self.get_object()
        product.is_active = False
        product.save(update_fields=["is_active"])
        return Response(status=204)

    @action(detail=True, methods=["post"], url_path="set-price")
    def set_price(self, request, pk=None):
        """Schedule a new walk-in selling price.

        Body: { price, effective_from (YYYY-MM-DD, default today), note (optional) }

        Closes any currently active ProductPrice (effective_to = new_from − 1 day)
        and opens a new row.  Past prices are never deleted.
        """
        from datetime import date as date_type
        product = self.get_object()

        raw_price = request.data.get("price")
        if raw_price is None:
            raise ValidationError({"price": "This field is required."})
        try:
            new_price = Decimal(str(raw_price))
            if new_price < 0:
                raise ValueError
        except (ValueError, Exception):
            raise ValidationError({"price": "Must be a non-negative number."})

        raw_from = request.data.get("effective_from")
        try:
            effective_from = date_type.fromisoformat(raw_from) if raw_from else timezone.localdate()
        except ValueError:
            raise ValidationError({"effective_from": "Use YYYY-MM-DD format."})

        note = (request.data.get("note") or "").strip()

        # Close the currently active row(s).
        close_to = effective_from - timedelta(days=1)
        ProductPrice.objects.filter(
            product=product, effective_to__isnull=True
        ).update(effective_to=close_to)

        row = ProductPrice.objects.create(
            product=product,
            price=new_price,
            effective_from=effective_from,
            changed_by=request.user if request.user.is_authenticated else None,
            note=note,
        )
        return Response(ProductPriceSerializer(row).data, status=201)

    @action(detail=True, methods=["get"], url_path="price-history")
    def price_history(self, request, pk=None):
        """Return all ProductPrice rows for this product, newest first."""
        product = self.get_object()
        rows = product.prices.order_by("-effective_from")
        return Response(ProductPriceSerializer(rows, many=True).data)

    @action(
        detail=False,
        methods=["post"],
        url_path="extract-from-menu",
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract_from_menu(self, request):
        """Read menu photo(s) via Claude vision and return product candidates not
        yet in the catalog.  Field name: `photos` (repeatable).  Returns a list
        of {name, category, selling_price, requires_preparation, is_combo}."""
        files = request.FILES.getlist("photos") or request.FILES.getlist("photos[]")
        if not files:
            raise ValidationError("Attach at least one menu photo (field 'photos').")

        from catalog import ai_extraction
        from catalog.ai_extraction import LLMUnavailable

        if not ai_extraction.available():
            return Response(
                {"detail": "Menu extraction requires a Claude API key — set ANTHROPIC_API_KEY in .env."},
                status=503,
            )

        known_names = list(
            Product.objects.filter(is_active=True).values_list("name", flat=True)
        )

        images = []
        for f in files:
            f.seek(0)
            images.append(f.read())

        try:
            candidates = ai_extraction.extract_menu(images, known_names)
            return Response(
                {
                    "photos_processed": len(files),
                    "new_count": len(candidates),
                    "candidates": candidates,
                }
            )
        except LLMUnavailable as exc:
            return Response({"detail": str(exc)}, status=503)
        except Exception as exc:
            return Response({"detail": f"Extraction failed: {exc}"}, status=500)


class ComboComponentViewSet(viewsets.ModelViewSet):
    queryset = ComboComponent.objects.select_related("combo_product", "component_product")
    serializer_class = ComboComponentSerializer
    permission_classes = [IsOwnerOrReadOnly]


class IngredientViewSet(viewsets.ModelViewSet):
    queryset = Ingredient.objects.prefetch_related("aliases", "pack_definitions")
    serializer_class = IngredientSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset().filter(is_active=True)
        mode = self.request.query_params.get("tracking_mode")
        if mode:
            qs = qs.filter(tracking_mode=mode)
        return qs

    def destroy(self, request, *args, **kwargs):
        ingredient = self.get_object()
        ingredient.is_active = False
        ingredient.save(update_fields=["is_active"])
        return Response(status=204)

    @action(
        detail=False,
        methods=["post"],
        url_path="extract-from-slips",
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract_from_slips(self, request):
        """OCR one or more slip images and return unique ingredient candidates.

        Priority chain:
          1. PaddleOCR PP-StructureV3  — table-aware; separates name/qty/unit columns
          2. Claude vision              — semantic name matching + handles bad images
          3. Tesseract                  — plain-text fallback (OcrUnavailable → 503)
        """
        files = request.FILES.getlist("slips") or request.FILES.getlist("slips[]")
        if not files:
            raise ValidationError("Attach at least one slip image (field 'slips').")

        known_names = list(
            Ingredient.objects.filter(is_active=True).values_list("name", flat=True)
        )
        known_aliases = list(
            SupplierProductAlias.objects.filter(is_active=True).values_list("alias_text", flat=True)
        )
        all_known = list({*known_names, *known_aliases})
        known_lower = {n.lower() for n in all_known}

        # ── 1. PaddleOCR PP-StructureV3 ─────────────────────────────────────
        try:
            from stock.ocr import (
                PaddleOcrUnavailable, PreprocessingError,
                available as paddle_available,
                extract_ingredients_from_slip,
            )
            from stock.ocr.normalizer import (
                suggest_clean_name, suggest_unit, suggest_pack_pieces,
            )
            from stock.extraction import build_existing_index, match_existing

            if paddle_available():
                index = build_existing_index()
                agg: dict[str, dict] = {}
                skipped_existing: set[str] = set()
                processed = 0

                for f in files:
                    f.seek(0)
                    raw_names = extract_ingredients_from_slip(f)
                    processed += 1
                    counted_this_slip: set[str] = set()
                    for raw in raw_names:
                        key = raw.lower().strip()
                        if key in known_lower:
                            skipped_existing.add(key)
                            continue
                        if match_existing(key, index):
                            skipped_existing.add(key)
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
                        if key not in counted_this_slip:
                            agg[key]["seen_in_slips"] += 1
                            counted_this_slip.add(key)

                if agg or processed == len(files):
                    return Response({
                        "slips_processed": processed,
                        "new_count": len(agg),
                        "skipped_existing": len(skipped_existing),
                        "candidates": list(agg.values()),
                        "ocr_engine": "paddleocr",
                    })
                # If all slips returned zero rows, fall through to Claude.
        except (PaddleOcrUnavailable, PreprocessingError):
            pass
        except ImportError:
            pass
        except Exception:
            pass

        # ── 2. Claude fallback ───────────────────────────────────────────────
        from catalog import ai_extraction
        from catalog.ai_extraction import LLMUnavailable

        if ai_extraction.available():
            try:
                images = []
                for f in files:
                    f.seek(0)
                    images.append(f.read())
                candidates = ai_extraction.extract_ingredients(images, all_known)
                return Response(
                    {
                        "slips_processed": len(files),
                        "new_count": len(candidates),
                        "skipped_existing": 0,
                        "candidates": candidates,
                        "ocr_engine": "gemini",
                    }
                )
            except LLMUnavailable as exc:
                detail = str(exc)
                if "quota" in detail.lower() or "429" in detail:
                    return Response({"detail": detail}, status=503)
            except Exception as exc:
                return Response({"detail": f"Extraction failed: {exc}"}, status=500)

        # ── 3. Tesseract last resort ─────────────────────────────────────────
        from stock.extraction import (
            OcrUnavailable,
            build_existing_index,
            extract_invoice_product_names,
            match_existing,
        )

        index = build_existing_index()
        agg2: dict[str, dict] = {}
        skipped2: set[str] = set()
        processed2 = 0

        for f in files:
            try:
                f.seek(0)
                names = extract_invoice_product_names(f)
            except OcrUnavailable as exc:
                return Response(
                    {
                        "detail": "OCR is unavailable — add ingredients manually below.",
                        "reason": str(exc),
                        "ocr_available": False,
                    },
                    status=503,
                )
            processed2 += 1
            counted_this_slip2: set[str] = set()
            for name in names:
                key = name.lower().strip()
                if key in known_lower or match_existing(key, index):
                    skipped2.add(key)
                    continue
                if key not in agg2:
                    agg2[key] = {
                        "raw_text": name,
                        "suggested_name": name,
                        "suggested_unit": "piece",
                        "suggested_qty_per_pack": None,
                        "cost_per_pack": None,
                        "tracking_mode": "RECIPE_LINKED",
                        "is_probably_not_ingredient": False,
                        "seen_in_slips": 0,
                    }
                if key not in counted_this_slip2:
                    agg2[key]["seen_in_slips"] += 1
                    counted_this_slip2.add(key)

        return Response(
            {
                "slips_processed": processed2,
                "new_count": len(agg2),
                "skipped_existing": len(skipped2),
                "candidates": list(agg2.values()),
                "ocr_engine": "tesseract",
            }
        )

        # ── Legacy generic Tesseract path (unreachable, kept for reference) ──
        from stock.extraction import (  # noqa: F401
            candidate_lines,
            dedup_key,
            ocr_text_from_fileobj,
            suggest_name,
            suggest_unit,
            _looks_like_non_ingredient,
        )

        index = build_existing_index()
        agg2: dict[str, dict] = {}
        skipped2: set[str] = set()
        processed2 = 0

        for f in files:
            try:
                f.seek(0)
                text = ocr_text_from_fileobj(f)
            except OcrUnavailable as exc:
                return Response(
                    {
                        "detail": "OCR is unavailable — add ingredients manually below.",
                        "reason": str(exc),
                        "ocr_available": False,
                    },
                    status=503,
                )
            processed += 1
            counted_this_slip: set[str] = set()
            for c in candidate_lines(text):
                norm = c["norm"]
                if match_existing(norm, index):
                    skipped_existing.add(dedup_key(norm))
                    continue
                key = dedup_key(norm)
                if not key:
                    continue
                row = agg.get(key)
                if row is None:
                    row = {
                        "raw_text": c["raw_text"],
                        "suggested_name": suggest_name(c["raw_text"]),
                        "suggested_unit": suggest_unit(c["raw_text"]),
                        "suggested_qty_per_pack": c["pack_pieces"],
                        "cost_per_pack": None,
                        "is_probably_not_ingredient": _looks_like_non_ingredient(norm),
                        "seen_in_slips": 0,
                    }
                    agg[key] = row
                if key not in counted_this_slip:
                    row["seen_in_slips"] += 1
                    counted_this_slip.add(key)
                if row["suggested_qty_per_pack"] is None and c["pack_pieces"] is not None:
                    row["suggested_qty_per_pack"] = c["pack_pieces"]

        candidates = sorted(
            agg.values(),
            key=lambda r: (r["is_probably_not_ingredient"], -r["seen_in_slips"]),
        )
        return Response(
            {
                "slips_processed": processed,
                "new_count": len(candidates),
                "skipped_existing": len(skipped_existing),
                "candidates": candidates,
            }
        )

    @action(detail=False, methods=["post"], url_path="bulk-create")
    def bulk_create(self, request):
        """Create several ingredients at once from the reviewed extraction rows.
        Body: {items:[{name, base_unit, tracking_mode, pieces_per_pack?,
        cost_per_pack?, alias?}]}. Each row also seeds a PackDefinition (when a
        pack yield is given) and a SupplierProductAlias (the slip wording)."""
        created_ids = []
        for item in request.data.get("items", []):
            name = (item.get("name") or "").strip()
            if not name:
                continue
            ingredient, _ = Ingredient.objects.get_or_create(
                name=name,
                defaults={
                    "base_unit": (item.get("base_unit") or "piece").strip() or "piece",
                    "tracking_mode": item.get("tracking_mode") or "RECIPE_LINKED",
                },
            )
            ppp = item.get("pieces_per_pack")
            if ppp not in (None, "") and not ingredient.pack_definitions.filter(
                effective_to__isnull=True
            ).exists():
                PackDefinition.objects.create(
                    ingredient=ingredient,
                    pieces_per_pack=Decimal(str(ppp)),
                    cost_per_pack=Decimal(str(item.get("cost_per_pack") or 0)),
                    effective_from=timezone.localdate(),
                )
            alias = (item.get("alias") or "").strip()
            if alias:
                SupplierProductAlias.objects.get_or_create(
                    ingredient=ingredient, alias_text=alias
                )
            created_ids.append(ingredient.id)

        ingredients = Ingredient.objects.filter(id__in=created_ids).prefetch_related(
            "aliases", "pack_definitions"
        )
        return Response(IngredientSerializer(ingredients, many=True).data, status=201)


class SupplierProductAliasViewSet(viewsets.ModelViewSet):
    queryset = SupplierProductAlias.objects.select_related("ingredient")
    serializer_class = SupplierProductAliasSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        ingredient = self.request.query_params.get("ingredient")
        if ingredient:
            qs = qs.filter(ingredient_id=ingredient)
        return qs


class PackDefinitionViewSet(viewsets.ModelViewSet):
    queryset = PackDefinition.objects.select_related("ingredient")
    serializer_class = PackDefinitionSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        ingredient = self.request.query_params.get("ingredient")
        if ingredient:
            qs = qs.filter(ingredient_id=ingredient)
        return qs

    def perform_create(self, serializer):
        """Editing pack size/cost versions history: close the current active row
        rather than overwriting it (same pattern as a price change)."""
        ingredient = serializer.validated_data["ingredient"]
        active = ingredient.pack_definitions.filter(effective_to__isnull=True).first()
        if active:
            active.effective_to = timezone.localdate() - timedelta(days=1)
            active.save(update_fields=["effective_to"])
        serializer.save()


class RecipeViewSet(viewsets.ModelViewSet):
    queryset = Recipe.objects.select_related("product", "ingredient")
    serializer_class = RecipeSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        product = self.request.query_params.get("product")
        if product:
            qs = qs.filter(product_id=product)
        return qs


class RecipeProductComponentViewSet(viewsets.ModelViewSet):
    queryset = RecipeProductComponent.objects.select_related("product", "component_product")
    serializer_class = RecipeProductComponentSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        product = self.request.query_params.get("product")
        if product:
            qs = qs.filter(product_id=product)
        return qs


class ProductPriceViewSet(viewsets.ModelViewSet):
    """Direct CRUD on individual ProductPrice rows.

    Use POST /products/{id}/set-price/ for the normal "change price going forward"
    flow (auto-closes current). Use this ViewSet to add historical records or fix
    existing entries without touching the close logic.
    """

    queryset = ProductPrice.objects.select_related("product", "changed_by").order_by("-effective_from")
    serializer_class = ProductPriceSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        product = self.request.query_params.get("product")
        if product:
            qs = qs.filter(product_id=product)
        return qs

    def _stamp_user(self, serializer):
        user = self.request.user
        serializer.save(changed_by=user if user.is_authenticated else None)

    def perform_create(self, serializer):
        self._stamp_user(serializer)

    def perform_update(self, serializer):
        self._stamp_user(serializer)
