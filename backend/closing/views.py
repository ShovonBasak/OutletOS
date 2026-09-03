from decimal import Decimal

from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from accounts.permissions import IsAdmin, IsOwnerOrAdmin, IsOwnerOrAdminOrReadOnly
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
    DailyClosingListSerializer,
    DailyClosingSerializer,
)
from .services import recompute_closing


class DailyClosingViewSet(viewsets.ModelViewSet):
    # Full prefetch — used for detail/create/update actions.
    queryset = DailyClosing.objects.prefetch_related(
        "stock_counts__product__prices",
        "stock_counts__product__recipes__ingredient__pack_definitions",
        "sales_lines__channel",
        "channel_discounts",
        "payments__account",
    ).select_related("outlet", "staff")
    serializer_class = DailyClosingSerializer

    # Slim prefetch for list — drops heavy stock_count product nesting; still
    # fetches sales_lines/channel_discounts/payments for the financial rollup
    # properties (total_sale, channel_day_net_revenue, computed_cash).
    _LIST_QUERYSET = DailyClosing.objects.prefetch_related(
        "stock_counts",
        "sales_lines__channel",
        "channel_discounts",
        "payments__account",
    ).select_related("outlet", "staff")

    def get_serializer_class(self):
        if self.action == "list" and self.request.query_params.get("expand") != "full":
            return DailyClosingListSerializer
        return DailyClosingSerializer

    def get_queryset(self):
        expand_full = self.request.query_params.get("expand") == "full"
        if self.action == "list" and not expand_full:
            base = self._LIST_QUERYSET
        else:
            base = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            base = base.filter(outlet_id=outlet)
        date = self.request.query_params.get("date")
        if date:
            base = base.filter(closing_date=date)
        date_from = self.request.query_params.get("date_from")
        if date_from:
            base = base.filter(closing_date__gte=date_from)
        date_to = self.request.query_params.get("date_to")
        if date_to:
            base = base.filter(closing_date__lte=date_to)
        status_param = self.request.query_params.get("status")
        if status_param:
            base = base.filter(status=status_param)
        if self.action == "list":
            base = base.order_by("-closing_date")
        return base

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

    @action(detail=False, methods=["get"], url_path="channel-summary")
    def channel_summary(self, request):
        """Aggregate sales by channel for a date range.

        Query params: outlet, date_from, date_to (all optional).
        Returns a list of {channel_id, channel_name, total_quantity, total_gross,
        total_discount, total_net} sorted by channel name.
        """
        from django.db.models import Sum

        outlet = request.query_params.get("outlet")
        date_from = request.query_params.get("date_from")
        date_to = request.query_params.get("date_to")

        lines_qs = DailyClosingSalesLine.objects.select_related("channel")
        if outlet:
            lines_qs = lines_qs.filter(daily_closing__outlet_id=outlet)
        if date_from:
            lines_qs = lines_qs.filter(daily_closing__closing_date__gte=date_from)
        if date_to:
            lines_qs = lines_qs.filter(daily_closing__closing_date__lte=date_to)

        by_channel = (
            lines_qs
            .values("channel__id", "channel__name")
            .annotate(
                total_quantity=Sum("quantity_sold"),
                total_gross=Sum("gross_amount"),
            )
            .order_by("channel__name")
        )

        discounts_qs = DailyChannelDiscount.objects.all()
        if outlet:
            discounts_qs = discounts_qs.filter(daily_closing__outlet_id=outlet)
        if date_from:
            discounts_qs = discounts_qs.filter(daily_closing__closing_date__gte=date_from)
        if date_to:
            discounts_qs = discounts_qs.filter(daily_closing__closing_date__lte=date_to)

        discount_by_channel = {}
        for row in discounts_qs.values("channel_id").annotate(total=Sum("discount_amount")):
            discount_by_channel[row["channel_id"]] = row["total"] or Decimal("0")

        result = []
        for row in by_channel:
            cid = row["channel__id"]
            gross = row["total_gross"] or Decimal("0")
            discount = discount_by_channel.get(cid, Decimal("0"))
            result.append({
                "channel_id": cid,
                "channel_name": row["channel__name"],
                "total_quantity": row["total_quantity"] or 0,
                "total_gross": str(gross),
                "total_discount": str(discount),
                "total_net": str(gross - discount),
            })

        return Response(result)

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
            obj, created = DailyClosingStockCount.objects.get_or_create(
                daily_closing=closing, product=product
            )
            obj.wastage_pieces = row.get("wastage_pieces", obj.wastage_pieces)
            obj.remains_pieces = row.get("remains_pieces", obj.remains_pieces)
            # Only read available_pieces from DisplayStock on first create. On re-saves,
            # DisplayStock for non-prep products has been set to `remains` by
            # _initialize_direct_stock (called during stock-in approval), so re-reading
            # it would collapse derived_walkin_sold to 0 for products not in that approval.
            if created:
                obj.available_pieces = ds.pieces_available if ds else 0

            # For direct-sale products (beverages/ready items), correct available_pieces
            # and remains_pieces to reflect the full day including any mid-day stock-in,
            # then sync RawStock to the true end-of-day balance.
            #
            # If the count was taken BEFORE the delivery arrived (remains <= day_start):
            #   available = day_start + stock_in  (total that passed through today)
            #   remains   = staff_count + stock_in  (true end-of-day physical balance)
            #   RawStock  = remains                 (delivery arrives on top of staff count)
            #
            # If the count was taken AFTER delivery (remains > day_start):
            #   available = day_start + stock_in  (same formula)
            #   remains   = staff_count           (delivery already in their count)
            #   RawStock  = remains               (physical balance)
            rawstock_updates = []  # (outlet, ingredient, qty) — applied after obj.save()
            if not product.requires_preparation:
                from stock.models import (
                    StockInItem, StockInStatus, OperatingDay, DayStartStockCheck,
                )
                remains_from_form = Decimal(row.get("remains_pieces", 0))
                op_day = OperatingDay.objects.filter(
                    outlet=closing.outlet, date=closing.closing_date
                ).first()
                for recipe in product.recipes.select_related("ingredient"):
                    today_stock_in = sum(
                        (item.base_unit_quantity()
                         for item in StockInItem.objects.filter(
                             stock_in_record__outlet=closing.outlet,
                             stock_in_record__stock_in_date=closing.closing_date,
                             stock_in_record__status=StockInStatus.APPROVED,
                             ingredient=recipe.ingredient,
                         )),
                        Decimal("0"),
                    )
                    qty_per = recipe.quantity_per_unit or Decimal("1")
                    if today_stock_in > 0 and op_day:
                        day_start_check = DayStartStockCheck.objects.filter(
                            operating_day=op_day, ingredient=recipe.ingredient
                        ).first()
                        day_start_pieces = (
                            int(day_start_check.confirmed_qty / qty_per)
                            if day_start_check else 0
                        )
                        stock_in_pieces = int(today_stock_in / qty_per)
                        count_after_delivery = int(remains_from_form) > day_start_pieces
                        obj.available_pieces = day_start_pieces + stock_in_pieces
                        if not count_after_delivery:
                            obj.remains_pieces = int(remains_from_form) + stock_in_pieces
                    rawstock_updates.append(
                        (closing.outlet, recipe.ingredient,
                         Decimal(obj.remains_pieces) * qty_per)
                    )

            obj.save()
            for outlet, ingredient, raw_qty in rawstock_updates:
                RawStock.set_to(outlet, ingredient, raw_qty)
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

    @action(detail=True, methods=["post"], permission_classes=[IsOwnerOrAdmin])
    def lock(self, request, pk=None):
        """Owner reviews a flagged closing and locks it."""
        closing = self.get_object()
        closing.status = ClosingStatus.LOCKED
        closing.save()
        self._close_operating_day(closing)
        self._record_account_transactions(closing, request.user)
        return self._fresh_response(closing)

    @action(detail=True, methods=["post"], permission_classes=[IsAdmin], url_path="reopen")
    def reopen(self, request, pk=None):
        """Owner reopens a LOCKED or SUBMITTED closing so staff can re-edit.

        Reverses everything _close_operating_day and _record_account_transactions did:
        - Deletes AccountTransaction rows tied to this closing
        - Adds back the DisplayStock that was deducted at close
        - Sets OperatingDay back to IN_PROGRESS
        - Sets DailyClosing back to DRAFT
        """
        from finance.models import AccountTransaction, SourceType
        from stock.models import DisplayStock, OperatingDay, OperatingDayStatus

        closing = self.get_object()
        if closing.status == ClosingStatus.DRAFT:
            raise ValidationError("Closing is already in DRAFT — nothing to reopen.")

        # 1. Delete account transactions created by this closing
        AccountTransaction.objects.filter(
            source_type=SourceType.DAILY_CLOSING,
            source_id=closing.id,
        ).delete()

        # 2. Restore DisplayStock: add back what was deducted at close
        #    (available_pieces − remains_pieces was deducted; add it back)
        for count in closing.stock_counts.all():
            restore = count.available_pieces - count.remains_pieces
            if restore > 0:
                DisplayStock.adjust(closing.outlet, count.product, restore)

        # 3. Reopen OperatingDay
        OperatingDay.objects.filter(
            outlet=closing.outlet,
            date=closing.closing_date,
        ).update(status=OperatingDayStatus.IN_PROGRESS)

        # 4. Reset closing to DRAFT
        closing.status = ClosingStatus.DRAFT
        closing.submitted_at = None
        closing.has_variance_flag = False
        closing.save()

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
        from stock.models import DisplayStock, OperatingDay, OperatingDayStatus

        # Deduct sold + wasted from DisplayStock so it ends the day at 'remains'.
        # This ensures the next day's carry-forward starts from the correct baseline
        # regardless of when data was entered.
        for count in closing.stock_counts.all():
            deduct = count.available_pieces - count.remains_pieces
            if deduct > 0:
                DisplayStock.adjust(closing.outlet, count.product, -deduct)

        # Close by date+outlet (reliable) and ensure the daily_closing FK is set
        # in case perform_create ran before the OperatingDay existed.
        OperatingDay.objects.filter(
            outlet=closing.outlet,
            date=closing.closing_date,
            daily_closing__isnull=True,
        ).update(status=OperatingDayStatus.CLOSED, daily_closing=closing)
        OperatingDay.objects.filter(
            outlet=closing.outlet,
            date=closing.closing_date,
            daily_closing__isnull=False,
        ).update(status=OperatingDayStatus.CLOSED)


class ChannelSettlementViewSet(viewsets.ModelViewSet):
    queryset = ChannelSettlement.objects.select_related("channel", "outlet")
    serializer_class = ChannelSettlementSerializer
    permission_classes = [IsOwnerOrAdminOrReadOnly]
