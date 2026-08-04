from rest_framework import serializers

from .models import CostCategory, Expense


class CostCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = CostCategory
        fields = ["id", "name", "cost_type"]


class ExpenseSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    cost_type = serializers.CharField(source="category.cost_type", read_only=True)
    paid_from_account_name = serializers.SerializerMethodField()

    class Meta:
        model = Expense
        fields = [
            "id", "outlet", "date", "category", "category_name", "cost_type",
            "amount", "source", "paid_from_account", "paid_from_account_name",
            "description", "entered_by", "recurring",
        ]
        read_only_fields = ["entered_by"]

    def get_paid_from_account_name(self, obj):
        if obj.paid_from_account:
            return obj.paid_from_account.name
        return None
