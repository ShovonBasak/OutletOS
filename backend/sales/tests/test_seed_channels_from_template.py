"""Tests for sales.services.seed_channels_from_template — the new-organization
Sales Channel / Menu Mapping template seeding described in CLAUDE.md's
onboarding flow.

Run with: python manage.py test sales.tests.test_seed_channels_from_template
"""
from django.test import TestCase

from catalog.models import Organization, Product
from finance.models import AccountType, FinancialAccount
from sales.models import ChannelMenuMap, ChannelMenuMapItem, SalesChannel
from sales.services import seed_channels_from_template


class SeedChannelsFromTemplateTests(TestCase):
    def setUp(self):
        self.template_org = Organization.objects.create(
            name="CP Five Star", slug="cp-five-star-seed-test", is_channel_template=True,
        )
        self.new_org = Organization.objects.create(name="New Franchise", slug="new-franchise-seed-test")
        self.product = Product.objects.create(name="Hot & Crispy Chicken")
        self.burger = Product.objects.create(name="Five Star Burger")

        self.foodpanda = SalesChannel.objects.create(
            organization=self.template_org, name="Foodpanda",
            commission_rate="0.1275", settlement_type="DIRECT_TO_ACCOUNT",
            integration_type="MANUAL", commission_basis="DISCOUNTED_PRICE",
        )
        self.walkin = SalesChannel.objects.create(
            organization=self.template_org, name="Walk-in",
        )
        self.menu_map = ChannelMenuMap.objects.create(
            channel=self.foodpanda, external_name="3X Hot & Crispy Chicken",
        )
        ChannelMenuMapItem.objects.create(
            menu_map=self.menu_map, product=self.product, quantity=3,
        )
        # Multi-item mapping (package deal) — exercises the part of the
        # seed that's new since menu maps stopped being single-product.
        self.combo_map = ChannelMenuMap.objects.create(
            channel=self.foodpanda, external_name="Burger & 2 Chicken Ball",
        )
        ChannelMenuMapItem.objects.create(menu_map=self.combo_map, product=self.burger, quantity=1)
        ChannelMenuMapItem.objects.create(menu_map=self.combo_map, product=self.product, quantity=2)

    def test_clones_channels_and_menu_maps(self):
        seed_channels_from_template(self.new_org)

        new_foodpanda = SalesChannel.objects.get(organization=self.new_org, name="Foodpanda")
        self.assertEqual(str(new_foodpanda.commission_rate), "0.1275")
        self.assertEqual(new_foodpanda.settlement_type, "DIRECT_TO_ACCOUNT")
        self.assertNotEqual(new_foodpanda.pk, self.foodpanda.pk)

        self.assertTrue(SalesChannel.objects.filter(organization=self.new_org, name="Walk-in").exists())

        new_map = ChannelMenuMap.objects.get(channel=new_foodpanda, external_name="3X Hot & Crispy Chicken")
        items = list(new_map.items.all())
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].product_id, self.product.id)
        self.assertEqual(items[0].quantity, 3)

        new_combo = ChannelMenuMap.objects.get(channel=new_foodpanda, external_name="Burger & 2 Chicken Ball")
        combo_items = {i.product_id: i.quantity for i in new_combo.items.all()}
        self.assertEqual(combo_items, {self.burger.id: 1, self.product.id: 2})

    def test_creates_holding_and_deposit_accounts_for_direct_to_account_channels(self):
        seed_channels_from_template(self.new_org)

        new_foodpanda = SalesChannel.objects.get(organization=self.new_org, name="Foodpanda")
        self.assertIsNotNone(new_foodpanda.holding_account)
        self.assertEqual(new_foodpanda.holding_account.account_type, AccountType.SALES_CHANNEL)
        self.assertEqual(new_foodpanda.holding_account.name, "Foodpanda Holding")
        self.assertEqual(new_foodpanda.holding_account.organization_id, self.new_org.id)

        deposit_accounts = FinancialAccount.objects.filter(
            organization=self.new_org, account_type=AccountType.BANK,
        )
        self.assertEqual(deposit_accounts.count(), 1)
        self.assertEqual(deposit_accounts.first().name, "Bank Account")

        # Walk-in is COLLECTED_AT_OUTLET — no holding account needed or created.
        new_walkin = SalesChannel.objects.get(organization=self.new_org, name="Walk-in")
        self.assertIsNone(new_walkin.holding_account)

    def test_clones_are_independent_of_the_template(self):
        seed_channels_from_template(self.new_org)

        new_foodpanda = SalesChannel.objects.get(organization=self.new_org, name="Foodpanda")
        new_foodpanda.commission_rate = "0.20"
        new_foodpanda.save(update_fields=["commission_rate"])

        self.foodpanda.refresh_from_db()
        self.assertEqual(str(self.foodpanda.commission_rate), "0.1275")

    def test_idempotent_does_not_duplicate(self):
        seed_channels_from_template(self.new_org)
        seed_channels_from_template(self.new_org)

        self.assertEqual(SalesChannel.objects.filter(organization=self.new_org).count(), 2)
        self.assertEqual(
            ChannelMenuMap.objects.filter(channel__organization=self.new_org).count(), 2
        )
        self.assertEqual(
            ChannelMenuMapItem.objects.filter(menu_map__channel__organization=self.new_org).count(), 3
        )
        self.assertEqual(
            FinancialAccount.objects.filter(organization=self.new_org, account_type=AccountType.SALES_CHANNEL).count(), 1
        )
        self.assertEqual(
            FinancialAccount.objects.filter(organization=self.new_org, account_type=AccountType.BANK).count(), 1
        )

    def test_noop_when_no_template_configured(self):
        self.template_org.is_channel_template = False
        self.template_org.save(update_fields=["is_channel_template"])

        seed_channels_from_template(self.new_org)

        self.assertEqual(SalesChannel.objects.filter(organization=self.new_org).count(), 0)
