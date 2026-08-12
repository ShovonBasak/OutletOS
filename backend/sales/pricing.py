"""Price resolution at sale time.

Order of precedence (most specific wins):
    1. ChannelPromotion applied to the active ProductPrice.price:
         product+channel  →  channel-only  →  product-only
    2. Plain active ProductPrice.price
The resolved value is snapshotted into DailyClosingSalesLine.unit_price.
"""
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone

from .models import ChannelPromotion, DiscountType


def _active_on(qs, on_date):
    return qs.filter(
        Q(effective_from__lte=on_date)
        & (Q(effective_to__isnull=True) | Q(effective_to__gte=on_date))
        & Q(is_active=True)
    )


def _apply_promo(base_price, promo):
    if promo.discount_type == DiscountType.PERCENTAGE:
        return (base_price * (Decimal("100") - promo.value) / Decimal("100")).quantize(
            Decimal("0.01")
        )
    return max(Decimal("0"), base_price - promo.value)


def resolve_price(product, channel, on_date=None):
    """Return (resolved_price, basis_label) for a product on a channel."""
    on_date = on_date or timezone.localdate()

    active_pp = product.active_price(as_of=on_date)
    base = active_pp.price if active_pp else Decimal("0")

    # Promotions, most specific first.
    promos = _active_on(ChannelPromotion.objects.all(), on_date)

    exact = promos.filter(product=product, channel=channel).first()
    if exact:
        return _apply_promo(base, exact), "promo_product_channel"

    channel_only = promos.filter(product__isnull=True, channel=channel).first()
    if channel_only:
        return _apply_promo(base, channel_only), "promo_channel"

    product_only = promos.filter(product=product, channel__isnull=True).first()
    if product_only:
        return _apply_promo(base, product_only), "promo_product"

    return base, "product_price"
