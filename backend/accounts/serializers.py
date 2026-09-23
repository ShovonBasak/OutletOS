from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import User


class UserSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    outlet_name = serializers.CharField(source="outlet.name", read_only=True, default=None)
    organization_name = serializers.CharField(source="organization.name", read_only=True, default=None)
    avatar_url = serializers.SerializerMethodField()
    # Drives the owner onboarding-wizard redirect in the frontend layout guard.
    # ADMIN has no organization and is never gated, hence the True default.
    organization_onboarding_complete = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id", "name", "role", "outlet", "outlet_name", "organization", "organization_name",
            "phone", "is_active", "password", "avatar_url", "organization_onboarding_complete",
        ]

    def get_organization_onboarding_complete(self, obj):
        if not obj.organization_id:
            return True
        return obj.organization.onboarding_completed_at is not None

    def get_avatar_url(self, obj):
        if not obj.avatar:
            return None
        request = self.context.get("request")
        if request:
            return request.build_absolute_uri(obj.avatar.url)
        return obj.avatar.url

    def create(self, validated_data):
        password = validated_data.pop("password", None) or None
        user = User(**validated_data)
        if password:
            user.set_password(password)
        user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if password:
            instance.set_password(password)
        instance.save()
        return instance


class RoleTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Embed role + identity into the login response so the frontend can route."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"] = user.role
        token["name"] = user.name
        token["organization_id"] = user.organization_id
        token["organization_name"] = user.organization.name if user.organization_id else None
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        request = self.context.get("request")
        data["user"] = UserSerializer(self.user, context={"request": request}).data
        return data
