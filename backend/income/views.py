from django.db.models import Sum
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from accounts.mixins import OrgScopedQuerySetMixin
from accounts.permissions import IsAdminOrReadOnly
from accounts.scoping import resolve_outlet_param
from .models import OtherIncomeCategory, OtherIncome
from .serializers import OtherIncomeCategorySerializer, OtherIncomeSerializer


class OtherIncomeCategoryViewSet(viewsets.ModelViewSet):
    # Global, not organization-scoped — every franchise outlet uses the same
    # other-income categories.
    queryset = OtherIncomeCategory.objects.all()
    serializer_class = OtherIncomeCategorySerializer
    permission_classes = [IsAdminOrReadOnly]


class OtherIncomeListPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = "page_size"
    max_page_size = 100


class OtherIncomeViewSet(OrgScopedQuerySetMixin, viewsets.ModelViewSet):
    queryset = OtherIncome.objects.select_related("category", "outlet", "received_into_account")
    serializer_class = OtherIncomeSerializer
    pagination_class = OtherIncomeListPagination
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
        if p.get("account"):
            qs = qs.filter(received_into_account_id=p["account"])
        return qs.order_by("-date", "-id")

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Totals for the current filter set, across every matching row —
        not just the page the list endpoint happens to return. Mirrors
        costs.views.ExpenseViewSet.summary."""
        qs = self.get_queryset()
        total = qs.aggregate(total=Sum("amount"))["total"] or 0
        count = qs.count()

        # .order_by() first — the queryset's own "-date", "-id" ordering would
        # otherwise leak into GROUP BY and split every row into its own group.
        by_category_rows = qs.order_by().values("category_id", "category__name").annotate(amount=Sum("amount"))
        by_category = sorted(
            [{"name": r["category__name"], "amount": r["amount"]} for r in by_category_rows],
            key=lambda r: -r["amount"],
        )

        account_rows = (
            qs.order_by().values("received_into_account_id", "received_into_account__name")
            .annotate(amount=Sum("amount"))
        )
        by_account_map: dict[str, float] = {}
        for r in account_rows:
            name = r["received_into_account__name"] or "Unspecified"
            by_account_map[name] = by_account_map.get(name, 0) + float(r["amount"])
        by_account = sorted(
            [{"name": name, "amount": amount} for name, amount in by_account_map.items()],
            key=lambda r: -r["amount"],
        )

        return Response({"total": total, "count": count, "by_category": by_category, "by_account": by_account})

    def perform_create(self, serializer):
        outlet = serializer.validated_data.get("outlet")
        user = self.request.user
        if outlet and not user.is_admin and outlet.organization_id != user.organization_id:
            raise ValidationError("Outlet does not belong to your organization.")
        income = serializer.save(entered_by=self.request.user)
        self._create_account_transaction(income)

    def perform_update(self, serializer):
        income = serializer.save()
        from finance import services
        from finance.models import AccountTransaction
        for t in AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=income.id):
            services.void_transaction(t.id)
        self._create_account_transaction(income)

    def perform_destroy(self, instance):
        from django.utils import timezone
        from finance import services
        from finance.models import AccountTransaction
        for t in AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=instance.id):
            services.void_transaction(t.id)
        instance.is_deleted = True
        instance.deleted_at = timezone.now()
        instance.deleted_by = self.request.user
        instance.save(update_fields=["is_deleted", "deleted_at", "deleted_by"])

    def _create_account_transaction(self, income):
        if not income.received_into_account_id:
            return
        from finance import services
        services.post_transaction(
            account=income.received_into_account, transaction_type="OTHER_INCOME",
            amount=income.amount, date=income.date, entered_by=income.entered_by,
            source_type="OTHER_INCOME", source_id=income.id,
            note=income.description or income.category.name,
        )
