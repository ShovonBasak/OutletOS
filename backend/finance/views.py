from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.utils import timezone
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.mixins import OrganizationOwnedMixin, OrgScopedQuerySetMixin
from accounts.permissions import IsAdmin, IsOwnerOrAdmin, IsOwnerOrAdminOrReadOnly
from accounts.scoping import resolve_organization_id
from . import services
from .models import (
    AccountType, FinancialAccount, AccountRoleAccess, AccountTransaction,
    AccountTransfer, CapitalTransaction, AccountBalanceCheck,
)
from .serializers import (
    FinancialAccountSerializer, FinancialAccountNameSerializer,
    AccountRoleAccessSerializer,
    AccountTransactionSerializer, AccountTransferSerializer,
    CapitalTransactionSerializer, AccountBalanceCheckSerializer,
)


class FinancialAccountViewSet(OrganizationOwnedMixin, viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def get_serializer_class(self):
        if self.request.user.is_owner_or_admin:
            return FinancialAccountSerializer
        return FinancialAccountNameSerializer

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated()]
        return [IsOwnerOrAdmin()]

    def get_queryset(self):
        qs = self.scope_queryset(FinancialAccount.objects.all())
        # Detail actions (retrieve/update/destroy) must see all accounts so that
        # inactive accounts can be fetched and reactivated — only filter on list.
        if self.action != "list":
            return qs
        # Apply role-based account access if configured for this user's role.
        role = self.request.user.role
        role_ids = list(
            AccountRoleAccess.objects.filter(role=role).values_list("account_id", flat=True)
        )
        if role_ids:
            qs = qs.filter(id__in=role_ids)
        if not self.request.user.is_owner_or_admin:
            return qs.filter(is_active=True)
        if self.request.query_params.get("is_active") != "all":
            return qs.filter(is_active=True)
        return qs

    def partial_update(self, request, *args, **kwargs):
        # Enforce single primary-cash account: unset all others in the SAME
        # organization before saving (never touch other tenants' accounts).
        if request.data.get("is_primary_cash"):
            account = self.get_object()
            FinancialAccount.objects.filter(
                organization=account.organization
            ).exclude(pk=account.pk).update(is_primary_cash=False)
        return super().partial_update(request, *args, **kwargs)

    def perform_update(self, serializer):
        old = self.get_object()
        old_ob, old_obd = old.opening_balance, old.opening_balance_date
        account = serializer.save()
        if account.opening_balance != old_ob or account.opening_balance_date != old_obd:
            # Every existing transaction's balance_before/after was computed
            # against the OLD opening_balance — the whole chain needs redoing.
            services.rebuild_account_balances(account.id)

    @action(detail=False, methods=["get"], permission_classes=[IsOwnerOrAdmin])
    def summary(self, request):
        """All active accounts with current balances — owner dashboard."""
        accounts = self.scope_queryset(FinancialAccount.objects.filter(is_active=True))
        data = FinancialAccountSerializer(accounts, many=True).data
        return Response(data)

    @action(detail=True, methods=["post"], permission_classes=[IsOwnerOrAdmin], url_path="recompute-balances")
    def recompute_balances(self, request, pk=None):
        """Owner/admin self-service repair — full replay from opening_balance.
        Idempotent; safe to run any time. Returns how many rows actually changed."""
        result = services.rebuild_account_balances(pk)
        return Response(result)

    @action(detail=False, methods=["post"], permission_classes=[IsOwnerOrAdmin], url_path="create-defaults")
    def create_defaults(self, request):
        """Onboarding wizard step: seed the three default accounts every new
        organization needs — "Owner Cash", "Shop Cash" (primary), "Supplier
        Credit". Body: {outlet}. get_or_create-keyed so it's safe to call more
        than once (e.g. the wizard resuming after a page refresh)."""
        outlet_id = request.data.get("outlet")
        if not outlet_id:
            raise ValidationError({"outlet": "This field is required."})

        org = self.resolve_organization()
        if org is None:
            raise ValidationError("Could not resolve your organization.")

        from catalog.models import Outlet
        if not Outlet.objects.filter(pk=outlet_id, organization=org).exists():
            raise ValidationError({"outlet": "Outlet not found in your organization."})

        today = timezone.localdate()
        defaults = [
            {"name": "Owner Cash", "account_type": AccountType.CASH, "is_primary_cash": False},
            {"name": "Shop Cash", "account_type": AccountType.CASH, "is_primary_cash": True},
            {"name": "Supplier Credit", "account_type": AccountType.SUPPLIER_CREDIT, "is_primary_cash": False},
        ]
        created = []
        with transaction.atomic():
            for d in defaults:
                account, _ = FinancialAccount.objects.get_or_create(
                    organization=org, outlet_id=outlet_id,
                    account_type=d["account_type"], name=d["name"],
                    defaults={
                        "opening_balance": Decimal("0"),
                        "opening_balance_date": today,
                        "is_primary_cash": d["is_primary_cash"],
                    },
                )
                created.append(account)

        return Response(FinancialAccountSerializer(created, many=True).data, status=201)


class AccountTransactionViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    """
    Read/create for owner+admin; destroy restricted to admin only.
    Expense/transfer/capital actions auto-create their transactions elsewhere.
    """
    queryset = AccountTransaction.objects.select_related("account", "entered_by")
    serializer_class = AccountTransactionSerializer
    org_lookup = "account__organization"

    def get_permissions(self):
        if self.action == "destroy":
            return [IsAdmin()]
        return [IsOwnerOrAdmin()]

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
        v = serializer.validated_data
        txn = services.post_transaction(
            account=v["account"], transaction_type=v["transaction_type"], amount=v["amount"],
            date=v["date"], entered_by=self.request.user, source_type="MANUAL",
            source_id=v.get("source_id"), note=v.get("note", ""),
        )
        serializer.instance = txn

    def perform_destroy(self, instance):
        services.void_transaction(instance.id)


class AccountTransferViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    queryset = AccountTransfer.objects.select_related("from_account", "to_account", "entered_by")
    serializer_class = AccountTransferSerializer
    permission_classes = [IsOwnerOrAdmin]
    org_lookup = "from_account__organization"

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
        services.post_transfer_pair(
            from_account=transfer.from_account, to_account=transfer.to_account,
            amount=transfer.amount, date=transfer.date, entered_by=self.request.user,
            source_type="ACCOUNT_TRANSFER", source_id=transfer.id,
            note_out=transfer.note or f"Transfer to {transfer.to_account.name}",
            note_in=transfer.note or f"Transfer from {transfer.from_account.name}",
        )

    def perform_destroy(self, instance):
        for t in AccountTransaction.objects.filter(
            source_type="ACCOUNT_TRANSFER", source_id=instance.id
        ):
            services.void_transaction(t.id)
        instance.delete()


class CapitalTransactionViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    queryset = CapitalTransaction.objects.select_related("account", "entered_by")
    serializer_class = CapitalTransactionSerializer
    permission_classes = [IsOwnerOrAdmin]
    org_lookup = "account__organization"

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
        services.post_transaction(
            account=cap.account, transaction_type=txn_type, amount=signed_amount, date=cap.date,
            entered_by=self.request.user, source_type="CAPITAL_TRANSACTION", source_id=cap.id,
            note=cap.note or cap.get_direction_display(),
        )

    def perform_destroy(self, instance):
        for t in AccountTransaction.objects.filter(
            source_type="CAPITAL_TRANSACTION", source_id=instance.id
        ):
            services.void_transaction(t.id)
        instance.delete()


class AccountBalanceCheckViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    queryset = AccountBalanceCheck.objects.select_related("account", "checked_by")
    serializer_class = AccountBalanceCheckSerializer
    permission_classes = [IsOwnerOrAdmin]
    org_lookup = "account__organization"

    def perform_create(self, serializer):
        from django.db import transaction as db_transaction

        account = serializer.validated_data["account"]
        actual_balance = serializer.validated_data["actual_balance"]

        # Lock before reading current_balance — otherwise a concurrent posting
        # between this read and the eventual ADJUSTMENT write could make the
        # computed discrepancy wrong (a classic read-then-write race).
        with db_transaction.atomic():
            locked = FinancialAccount.objects.select_for_update().get(pk=account.pk)
            system_balance = locked.current_balance
            discrepancy = actual_balance - system_balance

            check = serializer.save(
                checked_by=self.request.user,
                system_balance=system_balance,
                discrepancy=discrepancy,
            )

            if discrepancy != 0:
                services.post_transaction(
                    account=locked, transaction_type="ADJUSTMENT", amount=discrepancy,
                    date=check.checked_at.date(), entered_by=self.request.user,
                    source_type="ACCOUNT_BALANCE_CHECK", source_id=check.id,
                    note=f"Balance reconciliation: {check.get_reason_display() or 'Adjustment'}",
                )


class StaffCashView(APIView):
    """
    GET  — returns the primary cash account balance + all other active accounts.
    POST — creates a transfer from primary cash to another account.
    Accessible to any authenticated user (staff or owner).
    """
    permission_classes = [IsAuthenticated]

    def _cash_account(self, request):
        return FinancialAccount.objects.filter(
            organization_id=resolve_organization_id(request), is_primary_cash=True, is_active=True
        ).first()

    def get(self, request):
        cash = self._cash_account(request)
        if not cash:
            return Response({"error": "No primary cash account configured."}, status=404)

        others = (
            FinancialAccount.objects
            .filter(organization_id=resolve_organization_id(request), is_active=True)
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
        from django.db import transaction as db_transaction

        cash = self._cash_account(request)
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

        try:
            to_account = FinancialAccount.objects.get(
                pk=to_id, organization_id=resolve_organization_id(request), is_active=True
            )
        except FinancialAccount.DoesNotExist:
            return Response({"error": "Destination account not found."}, status=400)

        if to_account.pk == cash.pk:
            return Response({"error": "Cannot transfer to the same account."}, status=400)

        from django.utils.timezone import now
        transfer_date = now().date()
        transfer_note = note or f"Transfer to {to_account.name}"

        # Lock cash before checking the balance — otherwise two concurrent
        # transfers can both pass this check before either commits (TOCTOU).
        with db_transaction.atomic():
            locked_cash = FinancialAccount.objects.select_for_update().get(pk=cash.pk)
            if amount > locked_cash.current_balance:
                return Response({"error": "Transfer amount exceeds available cash balance."}, status=400)

            transfer = AccountTransfer.objects.create(
                from_account=locked_cash, to_account=to_account, amount=amount,
                date=transfer_date, note=transfer_note, entered_by=request.user,
            )
            services.post_transfer_pair(
                from_account=locked_cash, to_account=to_account, amount=amount, date=transfer_date,
                entered_by=request.user, source_type="ACCOUNT_TRANSFER", source_id=transfer.id,
                note_out=transfer_note, note_in=f"Transfer from {cash.name}",
            )

        return Response({
            "detail": "Transfer recorded.",
            "new_cash_balance": str(locked_cash.current_balance),
        })


class StaffCashHistoryView(APIView):
    """Paginated cash-account transaction history — accessible to staff and owner."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.core.paginator import Paginator
        from .models import TransactionType

        cash = FinancialAccount.objects.filter(
            organization_id=resolve_organization_id(request), is_primary_cash=True, is_active=True
        ).first()
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
                "balance_before": str(t.balance_before),
                "balance_after": str(t.balance_after),
                "source_type": t.source_type,
                "note": t.note,
                "category_name": expense_cats.get(t.source_id) if t.source_type == "EXPENSE" else None,
                "transfer_to_account": transfer_destinations.get(t.source_id) if t.transaction_type == "TRANSFER_OUT" else None,
            }
            for t in page_obj.object_list
        ]

        others = list(
            FinancialAccount.objects
            .filter(organization_id=resolve_organization_id(request), is_active=True)
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


class AccountRoleAccessViewSet(viewsets.ModelViewSet):
    """Admin-only: configure which accounts each role can see.

    GET  /account-role-access/        — list all mappings
    POST /account-role-access/        — add a mapping {role, account}
    DELETE /account-role-access/{id}/ — remove a mapping
    """
    serializer_class = AccountRoleAccessSerializer
    permission_classes = [IsAdmin]
    queryset = AccountRoleAccess.objects.select_related("account").all()

    def get_queryset(self):
        qs = super().get_queryset()
        org_param = self.request.query_params.get("organization")
        if org_param:
            qs = qs.filter(account__organization_id=org_param)
        role = self.request.query_params.get("role")
        if role:
            qs = qs.filter(role=role)
        return qs
