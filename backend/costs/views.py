from rest_framework import viewsets

from accounts.permissions import IsOwnerOrReadOnly
from .models import CostCategory, Expense
from .serializers import CostCategorySerializer, ExpenseSerializer


class CostCategoryViewSet(viewsets.ModelViewSet):
    queryset = CostCategory.objects.all()
    serializer_class = CostCategorySerializer
    permission_classes = [IsOwnerOrReadOnly]


class ExpenseViewSet(viewsets.ModelViewSet):
    queryset = Expense.objects.select_related("category", "outlet", "paid_from_account")
    serializer_class = ExpenseSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("outlet"):
            qs = qs.filter(outlet_id=p["outlet"])
        if p.get("date_from"):
            qs = qs.filter(date__gte=p["date_from"])
        if p.get("date_to"):
            qs = qs.filter(date__lte=p["date_to"])
        if p.get("category"):
            qs = qs.filter(category_id=p["category"])
        if p.get("cost_type"):
            qs = qs.filter(category__cost_type=p["cost_type"])
        return qs.order_by("-date", "-id")

    def perform_create(self, serializer):
        expense = serializer.save(entered_by=self.request.user)
        self._create_account_transaction(expense)

    def perform_update(self, serializer):
        old = self.get_object()
        expense = serializer.save()
        # Remove old transaction and recreate if account changed
        from finance.models import AccountTransaction
        AccountTransaction.objects.filter(source_type="EXPENSE", source_id=expense.id).delete()
        self._create_account_transaction(expense)

    def perform_destroy(self, instance):
        from finance.models import AccountTransaction
        AccountTransaction.objects.filter(source_type="EXPENSE", source_id=instance.id).delete()
        instance.delete()

    def _create_account_transaction(self, expense):
        if not expense.paid_from_account_id:
            return
        from finance.models import AccountTransaction
        AccountTransaction.objects.create(
            account=expense.paid_from_account,
            transaction_type="EXPENSE_PAYMENT",
            amount=-expense.amount,
            date=expense.date,
            source_type="EXPENSE",
            source_id=expense.id,
            entered_by=expense.entered_by,
            note=expense.description or f"{expense.category.name}",
        )
