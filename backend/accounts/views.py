from django.conf import settings
from rest_framework import parsers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import PushSubscription, Role, User
from .permissions import IsAdmin, IsOwnerOrAdmin
from .serializers import RoleTokenObtainPairSerializer, UserSerializer


class RoleTokenObtainPairView(TokenObtainPairView):
    serializer_class = RoleTokenObtainPairSerializer


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    permission_classes = [IsAdmin]


class TeamUserViewSet(viewsets.ModelViewSet):
    """User management for OWNER and ADMIN roles.
    OWNER can only see and manage STAFF users; cannot change roles or delete."""

    serializer_class = UserSerializer
    permission_classes = [IsOwnerOrAdmin]

    def get_queryset(self):
        if self.request.user.is_admin:
            return User.objects.all().order_by("name")
        return User.objects.filter(role=Role.STAFF).order_by("name")

    def perform_create(self, serializer):
        if not self.request.user.is_admin:
            serializer.save(role=Role.STAFF)
        else:
            serializer.save()

    def perform_update(self, serializer):
        instance = self.get_object()
        if not self.request.user.is_admin:
            serializer.save(role=instance.role)
        else:
            serializer.save()

    def destroy(self, request, *args, **kwargs):
        return Response(
            {"error": "Users cannot be deleted. Use toggle-active to deactivate."},
            status=status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    @action(detail=True, methods=["post"], url_path="toggle-active")
    def toggle_active(self, request, pk=None):
        user = self.get_object()
        user.is_active = not user.is_active
        user.save()
        return Response(UserSerializer(user).data)

    @action(detail=True, methods=["post"], url_path="reset-password")
    def reset_password(self, request, pk=None):
        user = self.get_object()
        password = request.data.get("password", "").strip()
        if len(password) < 8:
            return Response(
                {"error": "Password must be at least 8 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user.set_password(password)
        user.save()
        return Response({"detail": "Password reset successfully."})


class MeView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [parsers.MultiPartParser, parsers.FormParser, parsers.JSONParser]

    def get(self, request):
        return Response(UserSerializer(request.user, context={"request": request}).data)

    def patch(self, request):
        user = request.user
        name = (request.data.get("name") or "").strip()
        avatar = request.FILES.get("avatar")

        if name:
            user.name = name
        if avatar:
            if user.avatar:
                user.avatar.delete(save=False)
            user.avatar = avatar

        if name or avatar:
            user.save()

        return Response(UserSerializer(user, context={"request": request}).data)


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        current_password = request.data.get("current_password", "").strip()
        new_password = request.data.get("new_password", "").strip()

        if not current_password or not new_password:
            return Response(
                {"error": "Both current and new password are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(new_password) < 8:
            return Response(
                {"error": "New password must be at least 8 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not request.user.check_password(current_password):
            return Response(
                {"error": "Current password is incorrect."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        request.user.set_password(new_password)
        request.user.save()
        return Response({"detail": "Password changed successfully."})


class PushSubscriptionViewSet(viewsets.ViewSet):
    """Manage Web Push subscriptions for the authenticated user."""

    permission_classes = [IsAuthenticated]

    def create(self, request):
        """POST /push-subscriptions/ — upsert a subscription for the current user."""
        endpoint = request.data.get("endpoint", "").strip()
        p256dh = request.data.get("p256dh", "").strip()
        auth = request.data.get("auth", "").strip()
        if not endpoint or not p256dh or not auth:
            raise ValidationError("endpoint, p256dh, and auth are required.")
        PushSubscription.objects.update_or_create(
            endpoint=endpoint,
            defaults={"user": request.user, "p256dh": p256dh, "auth": auth},
        )
        return Response({"subscribed": True}, status=201)

    @action(detail=False, methods=["post"], url_path="remove")
    def remove(self, request):
        """POST /push-subscriptions/remove/ — unsubscribe by endpoint."""
        endpoint = request.data.get("endpoint", "").strip()
        if endpoint:
            PushSubscription.objects.filter(endpoint=endpoint, user=request.user).delete()
        return Response({"unsubscribed": True})

    @action(detail=False, methods=["get"], url_path="vapid-key")
    def vapid_key(self, request):
        """GET /push-subscriptions/vapid-key/ — return the VAPID public key."""
        return Response({"vapid_public_key": settings.VAPID_PUBLIC_KEY})
