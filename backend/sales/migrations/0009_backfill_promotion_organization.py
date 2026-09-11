from django.db import migrations

DEFAULT_ORG_SLUG = "cp-five-star"


def backfill(apps, schema_editor):
    Organization = apps.get_model("catalog", "Organization")
    ChannelPromotion = apps.get_model("sales", "ChannelPromotion")
    OrderLevelOffer = apps.get_model("sales", "OrderLevelOffer")

    default_org = Organization.objects.filter(slug=DEFAULT_ORG_SLUG).first()

    for promo in ChannelPromotion.objects.filter(organization__isnull=True):
        org = (
            (promo.channel.organization if promo.channel_id else None)
            or (promo.product.organization if promo.product_id else None)
            or default_org
        )
        if org:
            promo.organization = org
            promo.save(update_fields=["organization"])

    for offer in OrderLevelOffer.objects.filter(organization__isnull=True):
        org = (offer.channel.organization if offer.channel_id else None) or default_org
        if org:
            offer.organization = org
            offer.save(update_fields=["organization"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0008_channelpromotion_organization_and_more"),
        ("catalog", "0009_backfill_organization"),
    ]

    operations = [
        migrations.RunPython(backfill, noop),
    ]
