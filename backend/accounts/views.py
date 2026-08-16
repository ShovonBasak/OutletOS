from django.conf import settings
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import PushSubscription, User
from .permissions import IsOwner
from .serializers import RoleTokenObtainPairSerializer, UserSerializer


class RoleTokenObtainPairView(TokenObtainPairView):
    serializer_class = RoleTokenObtainPairSerializer


class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer
    permission_classes = [IsOwner]


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)


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
