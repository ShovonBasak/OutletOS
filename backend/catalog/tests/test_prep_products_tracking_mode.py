"""Regression test: the Prep page (GET /products/?prep=1) must expose each
recipe row's ingredient tracking_mode, so the frontend's "how many can I
prepare" cap can skip PERIODIC_COUNT ingredients the same way
stock.services.consume_for_preparation already does server-side. Without
this field, the frontend has no way to tell a periodic-count ingredient
(bags, sticks, sachets — never tracked via RawStock) apart from a normal
recipe-linked one, and silently hides the product the moment that outlet has
no RawStock row for it.

Run with: python manage.py test catalog.tests.test_prep_products_tracking_mode
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

from catalog.models import Ingredient, Organization, Outlet, Product, Recipe, TrackingMode

User = get_user_model()


class PrepProductsExposeTrackingModeTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Test Org", slug="test-org-prep-tracking-mode")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.staff = User.objects.create_user(
            phone="01700000801", password="x", name="Test Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        self.meat = Ingredient.objects.create(
            name="Chicken Ball Mix", base_unit="piece", tracking_mode=TrackingMode.RECIPE_LINKED,
        )
        self.stick = Ingredient.objects.create(
            name="Bamboo Stick", base_unit="piece", tracking_mode=TrackingMode.PERIODIC_COUNT,
        )
        self.product = Product.objects.create(
            name="Chicken Ball", requires_preparation=True, product_type="SINGLE",
        )
        Recipe.objects.create(product=self.product, ingredient=self.meat, quantity_per_unit=1, is_primary=True)
        Recipe.objects.create(product=self.product, ingredient=self.stick, quantity_per_unit=1)

        self.client_ = APIClient()
        self.client_.force_authenticate(user=self.staff)

    def test_recipe_rows_include_ingredient_tracking_mode(self):
        resp = self.client_.get("/api/products/?prep=1")
        self.assertEqual(resp.status_code, 200, resp.data)

        product = next(p for p in resp.data["results"] if p["id"] == self.product.id)
        by_ingredient = {r["ingredient"]: r["ingredient_tracking_mode"] for r in product["recipes"]}
        self.assertEqual(by_ingredient[self.meat.id], "RECIPE_LINKED")
        self.assertEqual(by_ingredient[self.stick.id], "PERIODIC_COUNT")
