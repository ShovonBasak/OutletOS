from decimal import Decimal, InvalidOperation

from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsAdmin, IsOwnerOrAdmin, IsOwnerOrAdminOrReadOnly
from .models import (
    FinancialAccount, AccountTransaction, AccountTransfer,
    CapitalTransaction, AccountBalanceCheck,
)
from .serializers import (
    FinancialAccountSerializer, FinancialAccountNameSerializer,
    AccountTransactionSerializer, AccountTransferSerializer,
    CapitalTransactionSerializer, AccountBalanceCheckSerializer,
)


class FinancialAccountViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def get_serializer_class(self):
        if self.request.user.is_owner_or_admin:
            return FinancialAccountSerializer
        return FinancialAccountNameSerializer

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated()]
        return [IsAdmin()]

    def get_queryset(self):
        qs = FinancialAccount.objects.all()
        # Detail actions (retrieve/update/destroy) must see all accounts so that
        # inactive accounts can be fetched and reactivated — only filter on list.
        if self.action != "list":
            return qs
        if not self.request.user.is_owner_or_admin:
            return qs.filter(is_active=True)
        if self.request.query_params.get("is_active") != "all":
            return qs.filter(is_active=True)
        return qs

    def partial_update(self, request, *args, **kwargs):
        # Enforce single primary-cash account: unset all others before saving.
        if request.data.get("is_primary_cash"):
            FinancialAccount.objects.exclude(pk=kwargs["pk"]).update(is_primary_cash=False)
        return super().partial_update(request, *args, **kwargs)

    @action(detail=False, methods=["get"], permission_classes=[IsOwnerOrAdmin])
    def summary(self, request):
        """All active accounts with current balances — owner dashboard."""
        accounts = FinancialAccount.objects.filter(is_active=True)
        data = FinancialAccountSerializer(accounts, many=True).data
        return Response(data)


class AccountTransactionViewSet(viewsets.ModelViewSet):
    """
    Read-only by default; manual ADJUSTMENT entries can be created by the owner.
    Expense/transfer/capital actions auto-create their transactions elsewhere.
    """
    queryset = AccountTransaction.objects.select_related("account", "entered_by")
    serializer_class = AccountTransactionSerializer
    permission_classes = [IsOwnerOrAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("account"):
            qs = qs.filter(account_id=p["account"])
        if p.get("date_from"):
            qs = qs.filter(date__gte=p["date_from"])
        if p.get("date_to"):
            qs = qs.filter(date__lte=p["date_to"])
        if p.get("transaction_type"):
            qs = qs.filter(transaction_type=p["transaction_type"])
        return qs

    def perform_create(self, serializer):
        serializer.save(entered_by=self.request.user, source_type="MANUAL")


class AccountTransferViewSet(viewsets.ModelViewSet):
    queryset = AccountTransfer.objects.select_related("from_account", "to_account", "entered_by")
    serializer_class = AccountTransferSerializer
    permission_classes = [IsOwnerOrAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("date_from"):
            qs = qs.filter(date__gte=p["date_from"])
        if p.get("date_to"):
            qs = qs.filter(date__lte=p["date_to"])
        return qs

    def perform_create(self, serializer):
        transfer = serializer.save(entered_by=self.request.user)
        AccountTransaction.objects.create(
            account=transfer.from_account,
            transaction_type="TRANSFER_OUT",
            amount=-transfer.amount,
            date=transfer.date,
            source_type="ACCOUNT_TRANSFER",
            source_id=transfer.id,
            entered_by=self.request.user,
            note=transfer.note or f"Transfer to {transfer.to_account.name}",
        )
        AccountTransaction.objects.create(
            account=transfer.to_account,
            transaction_type="TRANSFER_IN",
            amount=transfer.amount,
            date=transfer.date,
            source_type="ACCOUNT_TRANSFER",
            source_id=transfer.id,
            entered_by=self.request.user,
            note=transfer.note or f"Transfer from {transfer.from_account.name}",
        )

    def perform_destroy(self, instance):
        AccountTransaction.objects.filter(
            source_type="ACCOUNT_TRANSFER", source_id=instance.id
        ).delete()
        instance.delete()


class CapitalTransactionViewSet(viewsets.ModelViewSet):
    queryset = CapitalTransaction.objects.select_related("account", "entered_by")
    serializer_class = CapitalTransactionSerializer
    permission_classes = [IsOwnerOrAdmin]

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("date_from"):
            qs = qs.filter(date__gte=p["date_from"])
        if p.get("date_to"):
            qs = qs.filter(date__lte=p["date_to"])
        return qs

    def perform_create(self, serializer):
        cap = serializer.save(entered_by=self.request.user)
        signed_amount = cap.amount if cap.direction == "INJECTION" else -cap.amount
        txn_type = "CAPITAL_INJECTION" if cap.direction == "INJECTION" else "OWNER_WITHDRAWAL"
        AccountTransaction.objects.create(
            account=cap.account,
            transaction_type=txn_type,
            amount=signed_amount,
            date=cap.date,
            source_type="CAPITAL_TRANSACTION",
            source_id=cap.id,
            entered_by=self.request.user,
            note=cap.note or cap.get_direction_display(),
        )

    def perform_destroy(self, instance):
        AccountTransaction.objects.filter(
            source_type="CAPITAL_TRANSACTION", source_id=instance.id
        ).delete()
        instance.delete()


class AccountBalanceCheckViewSet(viewsets.ModelViewSet):
    queryset = AccountBalanceCheck.objects.select_related("account", "checked_by")
    serializer_class = AccountBalanceCheckSerializer
    permission_classes = [IsOwnerOrAdmin]

    def perform_create(self, serializer):
        account = serializer.validated_data["account"]
        system_balance = account.current_balance
        actual_balance = serializer.validated_data["actual_balance"]
        discrepancy = actual_balance - system_balance

        check = serializer.save(
            checked_by=self.request.user,
            system_balance=system_balance,
            discrepancy=discrepancy,
        )

        if discrepancy != 0:
            AccountTransaction.objects.create(
                account=account,
                transaction_type="ADJUSTMENT",
                amount=discrepancy,
                date=check.checked_at.date(),
                source_type="ACCOUNT_BALANCE_CHECK",
                source_id=check.id,
                entered_by=self.request.user,
                note=f"Balance reconciliation: {check.get_reason_display() or 'Adjustment'}",
            )


class StaffCashView(APIView):
    """
    GET  — returns the primary cash account balance + all other active accounts.
    POST — creates a transfer from primary cash to another account.
    Accessible to any authenticated user (staff or owner).
    """
    permission_classes = [IsAuthenticated]

    def _cash_account(self):
        return FinancialAccount.objects.filter(is_primary_cash=True, is_active=True).first()

    def get(self, request):
        cash = self._cash_account()
        if not cash:
            return Response({"error": "No primary cash account configured."}, status=404)

        others = (
            FinancialAccount.objects
            .filter(is_active=True)
            .exclude(pk=cash.pk)
            .values("id", "name", "account_type")
        )
        return Response({
            "cash": {
                "id": cash.id,
                "name": cash.name,
                "balance": str(cash.current_balance),
            },
            "accounts": list(others),
        })

    def post(self, request):
        cash = self._cash_account()
        if not cash:
            return Response({"error": "No primary cash account configured."}, status=404)

        to_id = request.data.get("to_account")
        amount_raw = request.data.get("amount", "")
        note = request.data.get("note", "").strip()

        try:
            amount = Decimal(str(amount_raw))
        except (InvalidOperation, ValueError):
            return Response({"error": "Invalid amount."}, status=400)

        if amount <= 0:
            return Response({"error": "Amount must be greater than zero."}, status=400)

        if amount > cash.current_balance:
            return Response({"error": "Transfer amount exceeds available cash balance."}, status=400)

        try:
            to_account = FinancialAccount.objects.get(pk=to_id, is_active=True)
        except FinancialAccount.DoesNotExist:
            return Response({"error": "Destination account not found."}, status=400)

        if to_account.pk == cash.pk:
            return Response({"error": "Cannot transfer to the same account."}, status=400)

        from django.utils.timezone import now
        transfer_date = now().date()
        transfer_note = note or f"Transfer to {to_account.name}"

        transfer = AccountTransfer.objects.create(
            from_account=cash,
            to_account=to_account,
            amount=amount,
            date=transfer_date,
            note=transfer_note,
            entered_by=request.user,
        )
        AccountTransaction.objects.create(
            account=cash,
            transaction_type="TRANSFER_OUT",
            amount=-amount,
            date=transfer_date,
            source_type="ACCOUNT_TRANSFER",
            source_id=transfer.id,
            entered_by=request.user,
            note=transfer_note,
        )
        AccountTransaction.objects.create(
            account=to_account,
            transaction_type="TRANSFER_IN",
            amount=amount,
            date=transfer_date,
            source_type="ACCOUNT_TRANSFER",
            source_id=transfer.id,
            entered_by=request.user,
            note=f"Transfer from {cash.name}",
        )

        return Response({
            "detail": "Transfer recorded.",
            "new_cash_balance": str(cash.current_balance),
        })


class StaffCashHistoryView(APIView):
    """Paginated cash-account transaction history — accessible to staff and owner."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.core.paginator import Paginator
        from .models import TransactionType

        cash = FinancialAccount.objects.filter(is_primary_cash=True, is_active=True).first()
        if not cash:
            return Response({"error": "No primary cash account configured."}, status=404)

        try:
            page = max(int(request.query_params.get("page", 1)), 1)
            page_size = min(int(request.query_params.get("page_size", 20)), 50)
        except (ValueError, TypeError):
            page, page_size = 1, 20

        qs = AccountTransaction.objects.filter(account=cash).order_by("-date", "-id")
        paginator = Paginator(qs, page_size)
        page_obj = paginator.get_page(page)

        from costs.models import Expense
        expense_ids = [
            t.source_id for t in page_obj.object_list
            if t.source_type == "EXPENSE" and t.source_id
        ]
        expense_cats: dict[int, str] = {}
        if expense_ids:
            for exp in Expense.objects.filter(id__in=expense_ids).select_related("category"):
                expense_cats[exp.id] = exp.category.name

        transfer_ids = [
            t.source_id for t in page_obj.object_list
            if t.transaction_type == "TRANSFER_OUT" and t.source_type == "ACCOUNT_TRANSFER" and t.source_id
        ]
        transfer_destinations: dict[int, str] = {}
        if transfer_ids:
            for tr in AccountTransfer.objects.filter(id__in=transfer_ids).select_related("to_account"):
                transfer_destinations[tr.id] = tr.to_account.name

        type_display = dict(TransactionType.choices)
        results = [
            {
                "id": t.id,
                "transaction_type": t.transaction_type,
                "transaction_type_display": type_display.get(t.transaction_type, t.transaction_type),
                "amount": str(t.amount),
                "date": str(t.date),
                "source_type": t.source_type,
                "note": t.note,
                "category_name": expense_cats.get(t.source_id) if t.source_type == "EXPENSE" else None,
                "transfer_to_account": transfer_destinations.get(t.source_id) if t.transaction_type == "TRANSFER_OUT" else None,
            }
            for t in page_obj.object_list
        ]

        others = list(
            FinancialAccount.objects
            .filter(is_active=True)
            .exclude(pk=cash.pk)
            .values("id", "name", "account_type")
        )

        return Response({
            "cash": {
                "id": cash.id,
                "name": cash.name,
                "balance": str(cash.current_balance),
            },
            "transactions": {
                "count": paginator.count,
                "page": page,
                "page_size": page_size,
                "total_pages": paginator.num_pages,
                "results": results,
            },
            "accounts": others,
        })
