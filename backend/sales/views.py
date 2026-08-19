from rest_framework import viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrReadOnly
from catalog.models import Product
from .models import (
    ChannelMenuMap,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)
from .pricing import resolve_price
from .serializers import (
    ChannelMenuMapSerializer,
    ChannelPromotionSerializer,
    OrderLevelOfferSerializer,
    SalesChannelSerializer,
    SalesChannelSlimSerializer,
)


def _recompute_channel_lines(channel):
    """Recompute gross/commission/net for all sales lines on this channel.
    Called automatically when commission_rate changes, and available via API.
    Returns the number of lines updated.
    """
    from closing.models import DailyClosingSalesLine
    lines = DailyClosingSalesLine.objects.filter(channel=channel).select_related("channel")
    count = 0
    for line in lines:
        line.recompute()
        line.save(update_fields=["gross_amount", "commission_amount", "net_amount"])
        count += 1
    return count


class SalesChannelViewSet(viewsets.ModelViewSet):
    queryset = SalesChannel.objects.all()
    serializer_class = SalesChannelSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_serializer_class(self):
        if self.action == "list" and self.request.query_params.get("slim") == "1":
            return SalesChannelSlimSerializer
        return SalesChannelSerializer

    def perform_update(self, serializer):
        old_rate = serializer.instance.commission_rate
        channel = serializer.save()
        if channel.commission_rate != old_rate:
            _recompute_channel_lines(channel)

    from rest_framework.decorators import action as _action

    @_action(detail=True, methods=["post"], url_path="recompute-commissions")
    def recompute_commissions(self, request, pk=None):
        """POST /sales-channels/<id>/recompute-commissions/ — manually trigger line recompute."""
        channel = self.get_object()
        count = _recompute_channel_lines(channel)
        return Response({"recomputed": count})


class ChannelPromotionViewSet(viewsets.ModelViewSet):
    queryset = ChannelPromotion.objects.all()
    serializer_class = ChannelPromotionSerializer
    permission_classes = [IsOwnerOrReadOnly]


class OrderLevelOfferViewSet(viewsets.ModelViewSet):
    queryset = OrderLevelOffer.objects.all()
    serializer_class = OrderLevelOfferSerializer
    permission_classes = [IsOwnerOrReadOnly]


class ChannelMenuMapViewSet(viewsets.ModelViewSet):
    queryset = ChannelMenuMap.objects.select_related("channel", "product")
    serializer_class = ChannelMenuMapSerializer
    permission_classes = [IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = super().get_queryset()
        channel = self.request.query_params.get("channel")
        if channel:
            qs = qs.filter(channel_id=channel)
        return qs


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def price_resolve(request):
    """?product=<id>&channel=<id> → resolved unit price + basis."""
    try:
        product = Product.objects.get(pk=request.query_params["product"])
        channel = SalesChannel.objects.get(pk=request.query_params["channel"])
    except (KeyError, Product.DoesNotExist, SalesChannel.DoesNotExist):
        return Response({"detail": "product and channel query params required."}, status=400)
    price, basis = resolve_price(product, channel)
    return Response({"product": product.id, "channel": channel.id, "price": price, "basis": basis})
