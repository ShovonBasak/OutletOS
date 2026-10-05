from django.db.models import Sum
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from accounts.mixins import OrgScopedQuerySetMixin
from accounts.permissions import IsAdminOrReadOnly
from accounts.scoping import resolve_outlet_param
from .models import CostCategory, CostType, Expense
from .serializers import CostCategorySerializer, ExpenseSerializer


class CostCategoryViewSet(viewsets.ModelViewSet):
    # Global, not organization-scoped — every franchise outlet uses the same
    # expense categories.
    queryset = CostCategory.objects.all()
    serializer_class = CostCategorySerializer
    permission_classes = [IsAdminOrReadOnly]


class ExpenseListPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = "page_size"
    max_page_size = 100


class ExpenseViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    queryset = Expense.objects.select_related("category", "outlet", "paid_from_account")
    serializer_class = ExpenseSerializer
    pagination_class = ExpenseListPagination
    org_lookup = "outlet__organization"

    def get_queryset(self):
        qs = super().get_queryset().filter(is_deleted=False)
        p = self.request.query_params
        outlet = resolve_outlet_param(self.request)
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        if p.get("date_from"):
            qs = qs.filter(date__gte=p["date_from"])
        if p.get("date_to"):
            qs = qs.filter(date__lte=p["date_to"])
        if p.get("category"):
            qs = qs.filter(category_id=p["category"])
        if p.get("cost_type"):
            qs = qs.filter(category__cost_type=p["cost_type"])
        if p.get("account"):
            qs = qs.filter(paid_from_account_id=p["account"])
        return qs.order_by("-date", "-id")

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Totals for the current filter set, across every matching row —
        not just the page the list endpoint happens to return. The list is
        paginated (10/page) so the frontend can no longer sum `results`
        client-side."""
        qs = self.get_queryset()
        total = qs.aggregate(total=Sum("amount"))["total"] or 0
        count = qs.count()

        # .order_by() first — the queryset's own "-date", "-id" ordering would
        # otherwise leak into GROUP BY and split every row into its own group.
        by_type_order = {CostType.FIXED: 0, CostType.VARIABLE: 1, CostType.ADHOC: 2}
        by_type_rows = qs.order_by().values("category__cost_type").annotate(amount=Sum("amount"))
        by_type = sorted(
            [{"cost_type": r["category__cost_type"], "amount": r["amount"]} for r in by_type_rows],
            key=lambda r: by_type_order.get(r["cost_type"], 99),
        )

        account_rows = (
            qs.order_by().values("paid_from_account_id", "paid_from_account__name", "source")
            .annotate(amount=Sum("amount"))
        )
        by_account_map: dict[str, float] = {}
        for r in account_rows:
            name = r["paid_from_account__name"] or ("bKash" if r["source"] == "BKASH" else "Cash")
            by_account_map[name] = by_account_map.get(name, 0) + float(r["amount"])
        by_account = sorted(
            [{"name": name, "amount": amount} for name, amount in by_account_map.items()],
            key=lambda r: -r["amount"],
        )

        return Response({"total": total, "count": count, "by_type": by_type, "by_account": by_account})

    def perform_create(self, serializer):
        outlet = serializer.validated_data.get("outlet")
        user = self.request.user
        if outlet and not user.is_admin and outlet.organization_id != user.organization_id:
            raise ValidationError("Outlet does not belong to your organization.")
        expense = serializer.save(entered_by=self.request.user)
        self._create_account_transaction(expense)

    def perform_update(self, serializer):
        expense = serializer.save()
        # Void the old transaction and repost — the amount/account/date may
        # have changed, so the whole chain from that point needs redoing.
        from finance import services
        from finance.models import AccountTransaction
        for t in AccountTransaction.objects.filter(source_type="EXPENSE", source_id=expense.id):
            services.void_transaction(t.id)
        self._create_account_transaction(expense)

    def perform_destroy(self, instance):
        from django.utils import timezone
        from finance import services
        from finance.models import AccountTransaction
        for t in AccountTransaction.objects.filter(source_type="EXPENSE", source_id=instance.id):
            services.void_transaction(t.id)
        instance.is_deleted = True
        instance.deleted_at = timezone.now()
        instance.deleted_by = self.request.user
        instance.save(update_fields=["is_deleted", "deleted_at", "deleted_by"])

    def _create_account_transaction(self, expense):
        if not expense.paid_from_account_id:
            return
        from finance import services
        services.post_transaction(
            account=expense.paid_from_account, transaction_type="EXPENSE_PAYMENT",
            amount=-expense.amount, date=expense.date, entered_by=expense.entered_by,
            source_type="EXPENSE", source_id=expense.id,
            note=expense.description or f"{expense.category.name}",
        )
