from rest_framework import viewsets

from accounts.permissions import IsAdminOrReadOnly, IsOwnerOrAdminOrReadOnly
from .models import OtherIncomeCategory, OtherIncome
from .serializers import OtherIncomeCategorySerializer, OtherIncomeSerializer


class OtherIncomeCategoryViewSet(viewsets.ModelViewSet):
    queryset = OtherIncomeCategory.objects.all()
    serializer_class = OtherIncomeCategorySerializer
    permission_classes = [IsAdminOrReadOnly]


class OtherIncomeViewSet(viewsets.ModelViewSet):
    queryset = OtherIncome.objects.select_related("category", "outlet", "received_into_account")
    serializer_class = OtherIncomeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        return qs

    def perform_create(self, serializer):
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
        from finance import services
        from finance.models import AccountTransaction
        for t in AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=instance.id):
            services.void_transaction(t.id)
        instance.delete()

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
