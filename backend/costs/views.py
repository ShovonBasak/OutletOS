from rest_framework import viewsets

from accounts.permissions import IsOwnerOrReadOnly
from .models import CostCategory, Expense
from .serializers import CostCategorySerializer, ExpenseSerializer


class CostCategoryViewSet(viewsets.ModelViewSet):
    queryset = CostCategory.objects.all()
    serializer_class = CostCategorySerializer
    permission_classes = [IsOwnerOrReadOnly]


class ExpenseViewSet(viewsets.ModelViewSet):
    queryset = Expense.objects.select_related("category", "outlet")
    serializer_class = ExpenseSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        outlet = self.request.query_params.get("outlet")
        if outlet:
            qs = qs.filter(outlet_id=outlet)
        return qs

    def perform_create(self, serializer):
        serializer.save(entered_by=self.request.user)
