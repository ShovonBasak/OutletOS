from rest_framework import viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrReadOnly
from catalog.models import Product
from .models import (
    ChannelMenuMap,
    ChannelPrice,
    ChannelPromotion,
    OrderLevelOffer,
    SalesChannel,
)
from .pricing import resolve_price
from .serializers import (
    ChannelMenuMapSerializer,
    ChannelPriceSerializer,
    ChannelPromotionSerializer,
    OrderLevelOfferSerializer,
    SalesChannelSerializer,
)


class SalesChannelViewSet(viewsets.ModelViewSet):
    queryset = SalesChannel.objects.all()
    serializer_class = SalesChannelSerializer
    permission_classes = [IsOwnerOrReadOnly]


class ChannelPriceViewSet(viewsets.ModelViewSet):
    queryset = ChannelPrice.objects.select_related("product", "channel")
    serializer_class = ChannelPriceSerializer
    permission_classes = [IsOwnerOrReadOnly]


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
