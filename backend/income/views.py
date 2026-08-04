from rest_framework import viewsets

from accounts.permissions import IsOwnerOrReadOnly
from .models import OtherIncomeCategory, OtherIncome
from .serializers import OtherIncomeCategorySerializer, OtherIncomeSerializer


class OtherIncomeCategoryViewSet(viewsets.ModelViewSet):
    queryset = OtherIncomeCategory.objects.all()
    serializer_class = OtherIncomeCategorySerializer
    permission_classes = [IsOwnerOrReadOnly]


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
        from finance.models import AccountTransaction
        AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=income.id).delete()
        self._create_account_transaction(income)

    def perform_destroy(self, instance):
        from finance.models import AccountTransaction
        AccountTransaction.objects.filter(source_type="OTHER_INCOME", source_id=instance.id).delete()
        instance.delete()

    def _create_account_transaction(self, income):
        if not income.received_into_account_id:
            return
        from finance.models import AccountTransaction
        AccountTransaction.objects.create(
            account=income.received_into_account,
            transaction_type="OTHER_INCOME",
            amount=income.amount,
            date=income.date,
            source_type="OTHER_INCOME",
            source_id=income.id,
            entered_by=income.entered_by,
            note=income.description or income.category.name,
        )
