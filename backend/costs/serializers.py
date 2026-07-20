from rest_framework import serializers

from .models import CostCategory, Expense


class CostCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = CostCategory
        fields = ["id", "name", "cost_type"]


class ExpenseSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    cost_type = serializers.CharField(source="category.cost_type", read_only=True)

    class Meta:
        model = Expense
        fields = [
            "id", "outlet", "date", "category", "category_name", "cost_type",
            "amount", "description", "entered_by", "recurring",
        ]
        read_only_fields = ["entered_by"]
