"""Tests for sales.services.seed_channels_from_template — the new-organization
Sales Channel / Menu Mapping template seeding described in CLAUDE.md's
onboarding flow.

Run with: python manage.py test sales.tests.test_seed_channels_from_template
"""
from django.test import TestCase

from catalog.models import Organization, Product
from sales.models import ChannelMenuMap, SalesChannel
from sales.services import seed_channels_from_template


class SeedChannelsFromTemplateTests(TestCase):
    def setUp(self):
        self.template_org = Organization.objects.create(
            name="CP Five Star", slug="cp-five-star-seed-test", is_channel_template=True,
        )
        self.new_org = Organization.objects.create(name="New Franchise", slug="new-franchise-seed-test")
        self.product = Product.objects.create(name="Hot & Crispy Chicken")

        self.foodpanda = SalesChannel.objects.create(
            organization=self.template_org, name="Foodpanda",
            commission_rate="0.1275", settlement_type="DIRECT_TO_ACCOUNT",
            integration_type="MANUAL", commission_basis="DISCOUNTED_PRICE",
        )
        self.walkin = SalesChannel.objects.create(
            organization=self.template_org, name="Walk-in",
        )
        ChannelMenuMap.objects.create(
            channel=self.foodpanda, external_name="3X Hot & Crispy Chicken",
            product=self.product, quantity_multiplier=3,
        )

    def test_clones_channels_and_menu_maps(self):
        seed_channels_from_template(self.new_org)

        new_foodpanda = SalesChannel.objects.get(organization=self.new_org, name="Foodpanda")
        self.assertEqual(str(new_foodpanda.commission_rate), "0.1275")
        self.assertEqual(new_foodpanda.settlement_type, "DIRECT_TO_ACCOUNT")
        self.assertNotEqual(new_foodpanda.pk, self.foodpanda.pk)

        self.assertTrue(SalesChannel.objects.filter(organization=self.new_org, name="Walk-in").exists())

        new_map = ChannelMenuMap.objects.get(channel=new_foodpanda, external_name="3X Hot & Crispy Chicken")
        self.assertEqual(new_map.product_id, self.product.id)
        self.assertEqual(new_map.quantity_multiplier, 3)

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
            ChannelMenuMap.objects.filter(channel__organization=self.new_org).count(), 1
        )

    def test_noop_when_no_template_configured(self):
        self.template_org.is_channel_template = False
        self.template_org.save(update_fields=["is_channel_template"])

        seed_channels_from_template(self.new_org)

        self.assertEqual(SalesChannel.objects.filter(organization=self.new_org).count(), 0)
