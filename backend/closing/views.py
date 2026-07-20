from decimal import Decimal

from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from accounts.permissions import IsOwner, IsOwnerOrReadOnly
from catalog.models import Product
from sales.models import SalesChannel
from sales.pricing import resolve_price
from .models import (
    ChannelSettlement,
    ClosingStatus,
    DailyChannelDiscount,
    DailyClosing,
    DailyClosingSalesLine,
    DailyClosingStockCount,
    LineSource,
    PaymentEntry,
    PaymentMethod,
)
from .serializers import (
    ChannelSettlementSerializer,
    DailyClosingSerializer,
)
from .services import recompute_closing


class DailyClosingViewSet(viewsets.ModelViewSet):
    queryset = DailyClosing.objects.prefetch_related(
        "stock_counts", "sales_lines", "channel_discounts", "payments"
    ).select_related("outlet", "staff")
    serializer_class = DailyClosingSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        date = self.request.query_params.get("date")
        if date:
            qs = qs.filter(closing_date=date)
        status_param = self.request.query_params.get("status")
        if status_param:
            qs = qs.filter(status=status_param)
        return qs

    def perform_create(self, serializer):
        closing = serializer.save(staff=self.request.user)
        # Link to today's OperatingDay so the gated flow knows closing has begun.
        from stock.models import OperatingDay

        day = OperatingDay.objects.filter(
            outlet=closing.outlet, date=closing.closing_date
        ).first()
        if day and not day.daily_closing_id:
            day.daily_closing = closing
            day.save(update_fields=["daily_closing"])

    def _guard_editable(self, closing):
        if closing.status == ClosingStatus.LOCKED:
            raise ValidationError("This closing is LOCKED and cannot be edited.")

    def _fresh_response(self, closing):
        """Re-fetch to bypass the stale prefetch cache after mutations."""
        fresh = self.get_queryset().get(pk=closing.pk)
        return Response(self.get_serializer(fresh).data)

    # ---- Step 1: Count remains & wastage ----
    @action(detail=True, methods=["post"], url_path="stock-count")
    def stock_count(self, request, pk=None):
        """Bulk upsert stock counts. Body: {"items": [{product, available_pieces,
        wastage_pieces, remains_pieces}, ...]}"""
        closing = self.get_object()
        self._guard_editable(closing)
        for row in request.data.get("items", []):
            product = Product.objects.get(pk=row["product"])
            obj, _ = DailyClosingStockCount.objects.get_or_create(
                daily_closing=closing, product=product
            )
            obj.available_pieces = row.get("available_pieces", obj.available_pieces)
            obj.wastage_pieces = row.get("wastage_pieces", obj.wastage_pieces)
            obj.remains_pieces = row.get("remains_pieces", obj.remains_pieces)
            obj.save()
        recompute_closing(closing)
        return self._fresh_response(closing)

    # ---- Step 2: Online sell (Pathao/Foodi/Foodpanda) ----
    @action(detail=True, methods=["post"], url_path="online-sell")
    def online_sell(self, request, pk=None):
        """Bulk upsert app-channel sales. Body: {"items": [{product, channel,
        quantity_sold}, ...]}. Walk-in is never accepted here."""
        closing = self.get_object()
        self._guard_editable(closing)
        walk_in = SalesChannel.objects.filter(name__iexact="Walk-in").first()
        for row in request.data.get("items", []):
            channel = SalesChannel.objects.get(pk=row["channel"])
            if walk_in and channel.id == walk_in.id:
                raise ValidationError("Walk-in sales are system-derived, not entered here.")
            product = Product.objects.get(pk=row["product"])
            qty = int(row.get("quantity_sold", 0))
            if qty <= 0:
                closing.sales_lines.filter(
                    product=product, channel=channel, source=LineSource.STAFF_ENTRY
                ).delete()
                continue
            price, _ = resolve_price(product, channel, closing.closing_date)
            line, _ = DailyClosingSalesLine.objects.get_or_create(
                daily_closing=closing, product=product, channel=channel,
                defaults={"source": LineSource.STAFF_ENTRY},
            )
            line.quantity_sold = qty
            line.unit_price = price
            line.source = LineSource.STAFF_ENTRY
            line.recompute()
            line.save()
        recompute_closing(closing)
        return self._fresh_response(closing)

    # ---- Step 2b: per-channel discount totals ----
    @action(detail=True, methods=["post"], url_path="channel-discounts")
    def channel_discounts(self, request, pk=None):
        closing = self.get_object()
        self._guard_editable(closing)
        for row in request.data.get("items", []):
            channel = SalesChannel.objects.get(pk=row["channel"])
            obj, _ = DailyChannelDiscount.objects.get_or_create(
                daily_closing=closing, channel=channel
            )
            obj.discount_amount = Decimal(str(row.get("discount_amount", 0)))
            obj.note = row.get("note", "")
            obj.save()
        return self._fresh_response(closing)

    # ---- Step 4: Payments (bKash/Card typed; cash computed) ----
    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        """Body: {"bkash": <amt>, "card": <amt>}. Cash is computed and stored."""
        closing = self.get_object()
        self._guard_editable(closing)
        recompute_closing(closing)
        for method, key in ((PaymentMethod.BKASH, "bkash"), (PaymentMethod.CARD, "card")):
            amount = Decimal(str(request.data.get(key, 0) or 0))
            obj, _ = PaymentEntry.objects.get_or_create(
                daily_closing=closing, method=method
            )
            obj.amount = amount
            obj.save()
        # Re-fetch so computed_cash reflects the just-rebuilt sales lines/payments.
        closing = self.get_queryset().get(pk=closing.pk)
        cash_obj, _ = PaymentEntry.objects.get_or_create(
            daily_closing=closing, method=PaymentMethod.CASH
        )
        cash_obj.amount = closing.computed_cash
        cash_obj.save()
        return self._fresh_response(closing)

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        """Staff finalizes: DRAFT → SUBMITTED, then auto-LOCK unless a flag exists."""
        closing = self.get_object()
        if closing.status == ClosingStatus.LOCKED:
            raise ValidationError("Already locked.")
        recompute_closing(closing)
        closing.status = ClosingStatus.SUBMITTED
        closing.submitted_at = timezone.now()
        closing.has_variance_flag = closing.has_flag
        if not closing.has_flag:
            closing.status = ClosingStatus.LOCKED
            self._close_operating_day(closing)
        closing.save()
        return self._fresh_response(closing)

    @action(detail=True, methods=["post"], permission_classes=[IsOwner])
    def lock(self, request, pk=None):
        """Owner reviews a flagged closing and locks it."""
        closing = self.get_object()
        closing.status = ClosingStatus.LOCKED
        closing.save()
        self._close_operating_day(closing)
        return self._fresh_response(closing)

    @staticmethod
    def _close_operating_day(closing):
        from stock.models import OperatingDay, OperatingDayStatus

        OperatingDay.objects.filter(daily_closing=closing).update(
            status=OperatingDayStatus.CLOSED
        )


class ChannelSettlementViewSet(viewsets.ModelViewSet):
    queryset = ChannelSettlement.objects.select_related("channel", "outlet")
    serializer_class = ChannelSettlementSerializer
    permission_classes = [IsOwnerOrReadOnly]
