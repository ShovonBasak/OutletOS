from django.db.models import Sum
from rest_framework import serializers

from .models import (
    FinancialAccount, AccountRoleAccess, AccountTransaction, AccountTransfer,
    CapitalTransaction, AccountBalanceCheck,
)


class FinancialAccountSerializer(serializers.ModelSerializer):
    current_balance = serializers.SerializerMethodField()
    account_type_display = serializers.CharField(source="get_account_type_display", read_only=True)

    class Meta:
        model = FinancialAccount
        fields = [
            "id", "outlet", "account_type", "account_type_display", "name", "provider",
            "opening_balance", "opening_balance_date", "is_active", "is_primary_cash",
            "current_balance",
        ]

    def get_current_balance(self, obj):
        txn_sum = obj.transactions.aggregate(total=Sum("amount"))["total"] or 0
        return str(obj.opening_balance + txn_sum)


class FinancialAccountNameSerializer(serializers.ModelSerializer):
    """Staff-safe: names and type only, no balances."""
    class Meta:
        model = FinancialAccount
        fields = ["id", "account_type", "name", "is_active", "is_primary_cash"]


class AccountTransactionSerializer(serializers.ModelSerializer):
    entered_by_name = serializers.CharField(source="entered_by.name", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)
    transaction_type_display = serializers.CharField(source="get_transaction_type_display", read_only=True)

    class Meta:
        model = AccountTransaction
        fields = [
            "id", "account", "account_name", "transaction_type", "transaction_type_display",
            "amount", "date", "source_type", "source_id",
            "entered_by", "entered_by_name", "note",
        ]
        read_only_fields = ["entered_by"]


class AccountTransferSerializer(serializers.ModelSerializer):
    from_account_name = serializers.CharField(source="from_account.name", read_only=True)
    to_account_name = serializers.CharField(source="to_account.name", read_only=True)
    entered_by_name = serializers.CharField(source="entered_by.name", read_only=True)

    class Meta:
        model = AccountTransfer
        fields = [
            "id", "from_account", "from_account_name", "to_account", "to_account_name",
            "amount", "date", "note", "entered_by", "entered_by_name",
        ]
        read_only_fields = ["entered_by"]


class CapitalTransactionSerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True)
    entered_by_name = serializers.CharField(source="entered_by.name", read_only=True)
    direction_display = serializers.CharField(source="get_direction_display", read_only=True)

    class Meta:
        model = CapitalTransaction
        fields = [
            "id", "account", "account_name", "direction", "direction_display",
            "amount", "date", "note", "entered_by", "entered_by_name",
        ]
        read_only_fields = ["entered_by"]


class AccountBalanceCheckSerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True)
    checked_by_name = serializers.CharField(source="checked_by.name", read_only=True)
    reason_display = serializers.CharField(source="get_reason_display", read_only=True)

    class Meta:
        model = AccountBalanceCheck
        fields = [
            "id", "account", "account_name", "checked_at", "checked_by",
            "checked_by_name", "system_balance", "actual_balance",
            "discrepancy", "reason", "reason_display", "note",
        ]
        read_only_fields = ["checked_by", "system_balance", "discrepancy"]


class AccountRoleAccessSerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True)
    account_type = serializers.CharField(source="account.account_type", read_only=True)

    class Meta:
        model = AccountRoleAccess
        fields = ["id", "role", "account", "account_name", "account_type"]
