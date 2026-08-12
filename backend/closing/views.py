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

    @action(detail=False, methods=["get"], url_path="active-work-date")
    def active_work_date(self, request):
        """Return the date the staff is currently working on.

        Priority:
          1. Most recent non-CLOSED OperatingDay — this is the authoritative
             work date even before closing is started (prep happens before closing).
          2. Most recent non-LOCKED DailyClosing — fallback when no open day exists.
          3. Today — final fallback.
        """
        from datetime import date as date_cls
        from stock.models import OperatingDay, OperatingDayStatus
        outlet = request.query_params.get("outlet", 1)

        active_day = (
            OperatingDay.objects.filter(outlet_id=outlet)
            .exclude(status=OperatingDayStatus.CLOSED)
            .order_by("-date")
            .first()
        )
        if active_day:
            return Response({"date": str(active_day.date)})

        closing = (
            DailyClosing.objects.filter(outlet_id=outlet)
            .exclude(status=ClosingStatus.LOCKED)
            .order_by("-closing_date")
            .first()
        )
        if closing:
            return Response({"date": str(closing.closing_date)})

        return Response({"date": str(date_cls.today())})

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
        """Bulk upsert stock counts. Body: {"items": [{product, wastage_pieces,
        remains_pieces}, ...]}. available_pieces is auto-filled from DisplayStock."""
        from stock.models import DisplayStock, RawStock
        closing = self.get_object()
        self._guard_editable(closing)
        for row in request.data.get("items", []):
            product = Product.objects.get(pk=row["product"])
            ds = DisplayStock.objects.filter(outlet=closing.outlet, product=product).first()
            available = ds.pieces_available if ds else 0
            obj, _ = DailyClosingStockCount.objects.get_or_create(
                daily_closing=closing, product=product
            )
            obj.available_pieces = available
            obj.wastage_pieces = row.get("wastage_pieces", obj.wastage_pieces)
            obj.remains_pieces = row.get("remains_pieces", obj.remains_pieces)
            obj.save()
            # For direct-sale products (beverages), sync RawStock to remains.
            if not product.requires_preparation:
                remains = Decimal(row.get("remains_pieces", 0))
                for recipe in product.recipes.select_related("ingredient"):
                    RawStock.set_to(
                        closing.outlet,
                        recipe.ingredient,
                        remains * recipe.quantity_per_unit,
                    )
        recompute_closing(closing)
        return self._fresh_response(closing)

    # ---- Step 2a: Upload platform Excel report (Foodpanda etc.) ----
    @action(detail=True, methods=["post"], url_path="import-online-sells")
    def import_online_sells(self, request, pk=None):
        """Parse a Foodpanda/platform order report XLSX and auto-register mapped sales lines.

        Form fields:
          file    — the XLSX file
          channel — SalesChannel id

        Response:
          mapped      — [{product_id, product_name, quantity}]  (registered automatically)
          unresolved  — [{external_name, order_qty}]             (needs mapping setup)
          closing     — full closing object
        """
        from rest_framework.parsers import MultiPartParser
        from .excel_parser import parse_foodpanda_excel

        closing = self.get_object()
        self._guard_editable(closing)

        file = request.FILES.get("file")
        if not file:
            from rest_framework.exceptions import ValidationError as DRFValidationError
            raise DRFValidationError("No file uploaded.")

        channel_id = request.data.get("channel")
        if not channel_id:
            from rest_framework.exceptions import ValidationError as DRFValidationError
            raise DRFValidationError("channel field is required.")

        channel = SalesChannel.objects.get(pk=channel_id)

        try:
            mapped, unresolved = parse_foodpanda_excel(file, closing.closing_date, channel)
        except (ValueError, KeyError) as exc:
            from rest_framework.exceptions import ValidationError as DRFValidationError
            raise DRFValidationError(str(exc))

        # Register each mapped product as a sales line (upsert, accumulating)
        for item in mapped:
            product = item["product"]
            qty = item["quantity"]
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

        mapped_out = [
            {"product_id": item["product"].id, "product_name": item["product"].name, "quantity": item["quantity"]}
            for item in mapped
        ]
        fresh = self.get_queryset().get(pk=closing.pk)
        return Response({
            "mapped": mapped_out,
            "unresolved": unresolved,
            "closing": self.get_serializer(fresh).data,
        })

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

    # ---- Step 4: Payments (per-account amounts; primary cash is computed) ----
    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        """Body: {"entries": [{"account_id": N, "amount": X}, ...]}.
        The primary-cash account is excluded from entries — its amount is the remainder."""
        from finance.models import FinancialAccount
        closing = self.get_object()
        self._guard_editable(closing)
        recompute_closing(closing)

        primary_cash = (
            FinancialAccount.objects.filter(is_primary_cash=True).first()
            or FinancialAccount.objects.filter(account_type="CASH", is_active=True).first()
        )

        # Rebuild non-cash entries from scratch (handles deletions cleanly).
        if primary_cash:
            closing.payments.exclude(account=primary_cash).delete()
        else:
            closing.payments.all().delete()

        for entry in request.data.get("entries", []):
            acc_id = entry.get("account_id")
            if not acc_id:
                continue
            amount = Decimal(str(entry.get("amount", 0) or 0))
            try:
                account = FinancialAccount.objects.get(pk=acc_id)
            except FinancialAccount.DoesNotExist:
                continue
            if primary_cash and account.pk == primary_cash.pk:
                continue  # cash is computed, not manually entered
            obj, _ = PaymentEntry.objects.get_or_create(
                daily_closing=closing, account=account
            )
            obj.amount = amount
            obj.save()

        # Recompute and save primary cash remainder.
        if primary_cash:
            closing_fresh = self.get_queryset().get(pk=closing.pk)
            cash_obj, _ = PaymentEntry.objects.get_or_create(
                daily_closing=closing_fresh, account=primary_cash
            )
            cash_obj.amount = closing_fresh.computed_cash
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
        self._record_account_transactions(closing, request.user)
        return self._fresh_response(closing)

    @action(detail=True, methods=["post"], permission_classes=[IsOwner])
    def lock(self, request, pk=None):
        """Owner reviews a flagged closing and locks it."""
        closing = self.get_object()
        closing.status = ClosingStatus.LOCKED
        closing.save()
        self._close_operating_day(closing)
        self._record_account_transactions(closing, request.user)
        return self._fresh_response(closing)

    @staticmethod
    def _record_account_transactions(closing, user):
        """Idempotently write SALES_COLLECTION transactions for each payment entry."""
        from finance.models import AccountTransaction, SourceType, TransactionType
        AccountTransaction.objects.filter(
            source_type=SourceType.DAILY_CLOSING,
            source_id=closing.id,
        ).delete()
        for payment in closing.payments.select_related("account").filter(amount__gt=0):
            AccountTransaction.objects.create(
                account=payment.account,
                transaction_type=TransactionType.SALES_COLLECTION,
                amount=payment.amount,
                date=closing.closing_date,
                source_type=SourceType.DAILY_CLOSING,
                source_id=closing.id,
                entered_by=user,
                note=f"Day closing — {closing.closing_date}",
            )

    @staticmethod
    def _close_operating_day(closing):
        from stock.models import OperatingDay, OperatingDayStatus

        # Close by date+outlet (reliable). The daily_closing FK may not be set
        # if the closing was created before the OperatingDay existed.
        OperatingDay.objects.filter(
            outlet=closing.outlet,
            date=closing.closing_date,
        ).update(status=OperatingDayStatus.CLOSED)


class ChannelSettlementViewSet(viewsets.ModelViewSet):
    queryset = ChannelSettlement.objects.select_related("channel", "outlet")
    serializer_class = ChannelSettlementSerializer
    permission_classes = [IsOwnerOrReadOnly]
