from datetime import timedelta
from decimal import Decimal

from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from accounts.permissions import IsAdminOrReadOnly, IsOwnerOrAdminOrReadOnly
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
    PrepProductSerializer,
    ProductListSerializer,
    ProductPriceSerializer,
    ProductSerializer,
    RecipeProductComponentSerializer,
    RecipeSerializer,
    SupplierProductAliasSerializer,
)


class OutletViewSet(viewsets.ModelViewSet):
    queryset = Outlet.objects.all()
    serializer_class = OutletSerializer
    permission_classes = [IsOwnerOrAdminOrReadOnly]


class ProductViewSet(viewsets.ModelViewSet):
    # Full prefetch used for detail/create/update and for ?expand=full list requests.
    queryset = Product.objects.all().prefetch_related(
        "components", "recipes__ingredient", "product_recipe_components__component_product", "prices"
    )
    serializer_class = ProductSerializer
    permission_classes = [IsAdminOrReadOnly]

    def get_serializer_class(self):
        if self.action == "list" and self.request.query_params.get("expand") != "full":
            if self.request.query_params.get("prep") == "1":
                return PrepProductSerializer
            return ProductListSerializer
        return ProductSerializer

    def get_queryset(self):
        p = self.request.query_params
        # Detail actions must see all products so inactive ones can be reactivated.
        if self.action != "list":
            return super().get_queryset()

        expand_full = p.get("expand") == "full"
        prep = p.get("prep") == "1"

        if expand_full:
            qs = Product.objects.all().prefetch_related(
                "components", "recipes__ingredient",
                "product_recipe_components__component_product", "prices",
            )
        elif prep:
            # Prep page: server-filtered to active SINGLE products requiring preparation.
            # Skip combo components prefetch — PrepProductSerializer doesn't use it.
            qs = Product.objects.filter(
                is_active=True, requires_preparation=True, product_type="SINGLE",
            ).prefetch_related(
                "recipes__ingredient",
                "product_recipe_components__component_product",
                "prices",
            )
        else:
            # Slim list: skip heavy nested prefetches, only fetch prices for selling_price.
            qs = Product.objects.all().prefetch_related("prices")

        if not prep:
            if not (self.request.user.is_owner_or_admin and p.get("include_inactive") == "1"):
                qs = qs.filter(is_active=True)
            ptype = p.get("product_type")
            if ptype:
                qs = qs.filter(product_type=ptype)
            category = p.get("category")
            if category:
                qs = qs.filter(category=category)
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
    permission_classes = [IsAdminOrReadOnly]


class IngredientViewSet(viewsets.ModelViewSet):
    queryset = Ingredient.objects.prefetch_related("aliases", "pack_definitions")
    serializer_class = IngredientSerializer
    permission_classes = [IsAdminOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset().filter(is_active=True)
        mode = self.request.query_params.get("tracking_mode")
        if mode:
            qs = qs.filter(tracking_mode=mode)
        return qs

    def get_serializer_class(self):
        from .serializers import IngredientPickerSerializer
        if self.action == "list" and self.request.query_params.get("slim") == "1":
            return IngredientPickerSerializer
        return IngredientSerializer

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
        """OCR one or more slip images with Claude AI and return unique ingredient candidates."""
        from catalog import ai_extraction
        from catalog.ai_extraction import LLMUnavailable

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

        images = [f.read() for f in files]
        try:
            candidates = ai_extraction.extract_ingredients(images, all_known)
        except LLMUnavailable as exc:
            return Response(
                {
                    "detail": str(exc),
                    "ocr_available": False,
                },
                status=503,
            )

        return Response(
            {
                "slips_processed": len(files),
                "new_count": len(candidates),
                "skipped_existing": 0,
                "candidates": candidates,
                "ocr_engine": "claude",
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
    permission_classes = [IsAdminOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        ingredient = self.request.query_params.get("ingredient")
        if ingredient:
            qs = qs.filter(ingredient_id=ingredient)
        return qs


class PackDefinitionViewSet(viewsets.ModelViewSet):
    queryset = PackDefinition.objects.select_related("ingredient")
    serializer_class = PackDefinitionSerializer
    permission_classes = [IsAdminOrReadOnly]

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
    permission_classes = [IsAdminOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        product = self.request.query_params.get("product")
        if product:
            qs = qs.filter(product_id=product)
        return qs


class RecipeProductComponentViewSet(viewsets.ModelViewSet):
    queryset = RecipeProductComponent.objects.select_related("product", "component_product")
    serializer_class = RecipeProductComponentSerializer
    permission_classes = [IsAdminOrReadOnly]

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
    permission_classes = [IsAdminOrReadOnly]

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
