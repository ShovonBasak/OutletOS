from rest_framework import serializers

from .models import OtherIncomeCategory, OtherIncome


class OtherIncomeCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = OtherIncomeCategory
        fields = ["id", "name"]


class OtherIncomeSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    received_into_account_name = serializers.SerializerMethodField()

    class Meta:
        model = OtherIncome
        fields = [
            "id", "outlet", "date", "category", "category_name",
            "amount", "received_into_account", "received_into_account_name",
            "description", "entered_by",
        ]
        read_only_fields = ["entered_by"]

    def get_received_into_account_name(self, obj):
        if obj.received_into_account:
            return obj.received_into_account.name
        return None
