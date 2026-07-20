"""Seed demo data for CP Five Star. Idempotent: safe to re-run.

    python manage.py seed

Reflects the updated ingredient/recipe model: what's received/stocked is an
Ingredient; what's sold is a Product; a Recipe links the two.
"""
from datetime import date
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db import transaction

from accounts.models import Role, User
from catalog.models import (
    ComboComponent,
    Ingredient,
    Outlet,
    PackDefinition,
    Product,
    ProductType,
    Recipe,
    SupplierProductAlias,
    TrackingMode,
)
from costs.models import CostCategory, CostType
from sales.models import IntegrationType, SalesChannel, SettlementType
from stock.models import RawStock


class Command(BaseCommand):
    help = "Seed demo data (outlet, users, ingredients, recipes, products, channels, costs)."

    @transaction.atomic
    def handle(self, *args, **options):
        outlet, _ = Outlet.objects.get_or_create(
            name="CP Five Star — Dhanmondi",
            defaults={"address": "Dhanmondi, Dhaka", "is_active": True},
        )

        owner, created = User.objects.get_or_create(
            phone="01700000000",
            defaults={"name": "Owner", "role": Role.OWNER, "is_staff": True, "is_superuser": True},
        )
        if created:
            owner.set_password("owner123")
            owner.save()

        staff, created = User.objects.get_or_create(
            phone="01800000000",
            defaults={"name": "Staff", "role": Role.STAFF, "outlet": outlet},
        )
        if created:
            staff.set_password("staff123")
            staff.save()

        # Channels (defaults per the data model).
        channels = {
            "Foodpanda": (Decimal("0.20"), SettlementType.DIRECT_TO_ACCOUNT),
            "Foodi": (Decimal("0.18"), SettlementType.COLLECTED_AT_OUTLET),
            "Pathao": (Decimal("0.18"), SettlementType.COLLECTED_AT_OUTLET),
            "Walk-in": (Decimal("0.00"), SettlementType.COLLECTED_AT_OUTLET),
        }
        for name, (rate, settle) in channels.items():
            SalesChannel.objects.get_or_create(
                name=name,
                defaults={
                    "commission_rate": rate,
                    "settlement_type": settle,
                    "integration_type": IntegrationType.MANUAL,
                    "is_active": True,
                },
            )

        # --- Ingredients (what's received/stocked) -------------------------
        # (name, base_unit, tracking_mode, pieces_per_pack, cost_per_pack,
        #  aliases, starting_raw_stock)
        ingredients_spec = [
            ("Burger Bun", "piece", TrackingMode.RECIPE_LINKED, 10, 200,
             ["BURGER BUN 10PC", "BUN"], 40),
            ("Crispy Patty", "piece", TrackingMode.RECIPE_LINKED, 10, 900,
             ["CKN PATTY 5IN 10PC", "CRISPY PATTY"], 40),
            ("Mayonnaise", "portion", TrackingMode.RECIPE_LINKED, 22, 220,
             ["MAYO BOTTLE", "MAYONNAISE 1L"], 66),
            ("Bamboo Stick", "piece", TrackingMode.RECIPE_LINKED, 100, 100,
             ["BAMBOO STICK 100/BAG", "SKEWER"], 200),
            ("Chicken Ball (raw)", "piece", TrackingMode.RECIPE_LINKED, 50, 500,
             ["CKN BALL RAW 50PC", "CHICKEN BALL"], 100),
            ("Raw Chicken", "piece", TrackingMode.RECIPE_LINKED, 15, 900,
             ["RAW CHICKEN 15PC", "CHICKEN CUT"], 45),
            ("Wrap Bread", "piece", TrackingMode.RECIPE_LINKED, 10, 150,
             ["WRAP BREAD 10PC", "TORTILLA"], 30),
            ("Cold Drink 250ml", "piece", TrackingMode.RECIPE_LINKED, 24, 600,
             ["COLD DRINK 250ML", "SOFT DRINK CAN"], 48),
            # Packaging & supplies — periodic count, not recipe-linked.
            ("Medium Bag", "piece", TrackingMode.PERIODIC_COUNT, 100, 300,
             ["MEDIUM BAG 100PC", "PAPER BAG M"], 100),
            ("Sauce Packet", "piece", TrackingMode.PERIODIC_COUNT, 200, 200,
             ["SAUCE PACKET 200PC", "KETCHUP SACHET"], 200),
        ]
        ings = {}
        for name, unit, mode, ppp, cost, aliases, start in ingredients_spec:
            ing, _ = Ingredient.objects.get_or_create(
                name=name, defaults={"base_unit": unit, "tracking_mode": mode},
            )
            ings[name] = ing
            if not ing.pack_definitions.filter(effective_to__isnull=True).exists():
                PackDefinition.objects.create(
                    ingredient=ing,
                    pieces_per_pack=Decimal(ppp),
                    cost_per_pack=Decimal(cost),
                    effective_from=date(2026, 1, 1),
                )
            for alias in aliases:
                SupplierProductAlias.objects.get_or_create(ingredient=ing, alias_text=alias)
            RawStock.objects.get_or_create(
                outlet=outlet, ingredient=ing,
                defaults={"quantity_available": Decimal(start)},
            )

        # --- Products (what's sold) + recipes ------------------------------
        # (name, category, requires_prep, price, recipe: [(ingredient, qty)])
        products_spec = [
            ("5★ Burger", "Burger", True, 220,
             [("Burger Bun", 1), ("Crispy Patty", 1), ("Mayonnaise", 1)]),
            ("Crispy Fry", "Chicken", True, 180,
             [("Raw Chicken", 1)]),
            ("Chicken Ball (4pc)", "Snacks", True, 160,
             [("Chicken Ball (raw)", 4), ("Bamboo Stick", 1)]),
            ("Chicken Wrap", "Wrap", True, 200,
             [("Wrap Bread", 1), ("Crispy Patty", 1), ("Mayonnaise", 1)]),
            ("Cold Drink 250ml", "Beverage", False, 40,
             [("Cold Drink 250ml", 1)]),
        ]
        product_objs = {}
        for name, cat, prep, price, recipe in products_spec:
            p, _ = Product.objects.get_or_create(
                name=name,
                defaults={
                    "category": cat,
                    "product_type": ProductType.SINGLE,
                    "requires_preparation": prep,
                    "selling_price": Decimal(price),
                },
            )
            product_objs[name] = p
            for ing_name, qty in recipe:
                Recipe.objects.get_or_create(
                    product=p, ingredient=ings[ing_name],
                    defaults={"quantity_per_unit": Decimal(qty)},
                )

        # A combo: Burger + Drink.
        combo, _ = Product.objects.get_or_create(
            name="Buddy Combo",
            defaults={
                "category": "Combo",
                "product_type": ProductType.COMBO,
                "requires_preparation": False,
                "selling_price": Decimal("240"),
            },
        )
        ComboComponent.objects.get_or_create(
            combo_product=combo, component_product=product_objs["5★ Burger"],
            defaults={"quantity_per_combo": 1},
        )
        ComboComponent.objects.get_or_create(
            combo_product=combo, component_product=product_objs["Cold Drink 250ml"],
            defaults={"quantity_per_combo": 1},
        )

        # Cost categories.
        for name, ctype in [
            ("Rent", CostType.FIXED), ("Salary", CostType.FIXED),
            ("Gas", CostType.VARIABLE), ("Oil", CostType.VARIABLE),
            ("Repairs", CostType.ADHOC),
        ]:
            CostCategory.objects.get_or_create(name=name, defaults={"cost_type": ctype})

        self.stdout.write(self.style.SUCCESS("Seeded. Logins:"))
        self.stdout.write("  Owner  phone=01700000000  password=owner123")
        self.stdout.write("  Staff  phone=01800000000  password=staff123")
