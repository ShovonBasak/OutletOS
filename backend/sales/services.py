"""Sales-channel template seeding for newly created organizations.

The catalog (Product/Ingredient/Recipe) is shared across every CP Five Star
franchise, but Sales Channels and Menu Mapping are per-organization rows —
without this, a new organization's Settings → Sales channels / Menu mapping
screens start completely empty and the owner has to build Pathao/Foodi/
Foodpanda from scratch. Cloning from the designated template organization
gives them a working starting point that's still fully theirs to edit.
"""
from .models import ChannelMenuMap, SalesChannel


def seed_channels_from_template(org):
    """Copy the template organization's SalesChannel + ChannelMenuMap rows
    into `org`. The clones are independent rows from the moment they're
    created — editing/deleting them on either side has no effect on the
    other. Safe to call more than once: get_or_create-keyed on (org, name)
    for channels and (channel, external_name) for menu maps, so re-running
    never duplicates rows. No-op if no template organization is configured."""
    from catalog.models import Organization

    template_org = (
        Organization.objects.filter(is_channel_template=True).exclude(pk=org.pk).first()
    )
    if template_org is None:
        return

    for template_channel in template_org.sales_channels.all():
        channel, _ = SalesChannel.objects.get_or_create(
            organization=org,
            name=template_channel.name,
            defaults={
                "commission_rate": template_channel.commission_rate,
                "settlement_type": template_channel.settlement_type,
                "integration_type": template_channel.integration_type,
                "commission_basis": template_channel.commission_basis,
                "is_active": template_channel.is_active,
            },
        )
        for template_map in template_channel.menu_maps.all():
            ChannelMenuMap.objects.get_or_create(
                channel=channel,
                external_name=template_map.external_name,
                defaults={
                    "product": template_map.product,
                    "quantity_multiplier": template_map.quantity_multiplier,
                    "is_active": template_map.is_active,
                },
            )
