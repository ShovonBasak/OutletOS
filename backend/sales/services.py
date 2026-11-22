"""Sales-channel template seeding for newly created organizations.

The catalog (Product/Ingredient/Recipe) is shared across every CP Five Star
franchise, but Sales Channels and Menu Mapping are per-organization rows —
without this, a new organization's Settings → Sales channels / Menu mapping
screens start completely empty and the owner has to build Pathao/Foodi/
Foodpanda from scratch. Cloning from the designated template organization
gives them a working starting point that's still fully theirs to edit.
"""
from decimal import Decimal

from django.utils import timezone

from .models import ChannelMenuMap, ChannelMenuMapItem, SalesChannel, SettlementType


def seed_channels_from_template(org):
    """Copy the template organization's SalesChannel + ChannelMenuMap (+ items)
    rows into `org`. The clones are independent rows from the moment they're
    created — editing/deleting them on either side has no effect on the
    other. Safe to call more than once: get_or_create-keyed on (org, name)
    for channels, (channel, external_name) for menu maps, and (menu_map,
    product) for items, so re-running never duplicates rows. No-op if no
    template organization is configured.

    Any Direct-to-account channel (e.g. Foodpanda) also gets a holding
    account auto-created and linked — without one, that channel's revenue
    has nowhere to post on day-close (see closing.services.
    record_account_transactions, which silently skips a channel with no
    holding_account). All such channels share a single generic bank account
    as their settlement deposit target default; the owner can repoint
    individual settlements to a different account later. Called before any
    Outlet exists for this org (both callers create the org's first Outlet
    after this), so these accounts are created outlet-less."""
    from catalog.models import Organization
    from finance.models import AccountType, FinancialAccount

    template_org = (
        Organization.objects.filter(is_channel_template=True).exclude(pk=org.pk).first()
    )
    if template_org is None:
        return

    today = timezone.localdate()
    deposit_account = None  # created lazily, shared across channels

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
            menu_map, _ = ChannelMenuMap.objects.get_or_create(
                channel=channel,
                external_name=template_map.external_name,
                defaults={"is_active": template_map.is_active},
            )
            for template_item in template_map.items.all():
                ChannelMenuMapItem.objects.get_or_create(
                    menu_map=menu_map,
                    product=template_item.product,
                    defaults={"quantity": template_item.quantity},
                )

        if channel.settlement_type == SettlementType.DIRECT_TO_ACCOUNT and not channel.holding_account:
            holding_account, _ = FinancialAccount.objects.get_or_create(
                organization=org, account_type=AccountType.SALES_CHANNEL,
                name=f"{channel.name} Holding",
                defaults={"opening_balance": Decimal("0"), "opening_balance_date": today},
            )
            channel.holding_account = holding_account
            channel.save(update_fields=["holding_account"])

            if deposit_account is None:
                deposit_account, _ = FinancialAccount.objects.get_or_create(
                    organization=org, account_type=AccountType.BANK, name="Bank Account",
                    defaults={"opening_balance": Decimal("0"), "opening_balance_date": today},
                )
