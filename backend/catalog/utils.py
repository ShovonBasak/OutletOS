from collections import Counter

from django.core.cache import cache

# Same order used in the closing stock screen — earlier = higher priority on ties.
PRODUCT_CATEGORY_ORDER = [
    "Fried Chicken",
    "Snacks",
    "Light Snacks",
    "Meals",
    "Rice & Sides",
    "Beverages",
    "Add-on",
    "Combo",
]

_CATEGORY_MAP_KEY = "catalog:ingredient_category_map"
_PRODUCT_MAP_KEY = "catalog:ingredient_product_map"
_CACHE_TTL = 1800  # 30 minutes — auto-refreshes after recipe edits


def build_ingredient_category_map():
    """Return {ingredient_id: dominant_product_category} derived from Recipe.

    Dominant = highest recipe count across products in that category.
    Ties broken by PRODUCT_CATEGORY_ORDER (earlier wins).
    Ingredients with no recipes map to 'Other'.
    Cached in-process for 30 minutes.
    """
    cached = cache.get(_CATEGORY_MAP_KEY)
    if cached is not None:
        return cached

    from catalog.models import Recipe

    rows = Recipe.objects.values_list("ingredient_id", "product__category")
    by_ingredient: dict[int, Counter] = {}
    for iid, cat in rows:
        by_ingredient.setdefault(iid, Counter())[cat] += 1

    result = {}
    for iid, counter in by_ingredient.items():
        max_count = max(counter.values())
        candidates = [cat for cat, cnt in counter.items() if cnt == max_count]
        # Pick by category order; unknown categories go last
        candidates.sort(
            key=lambda c: PRODUCT_CATEGORY_ORDER.index(c)
            if c in PRODUCT_CATEGORY_ORDER
            else len(PRODUCT_CATEGORY_ORDER)
        )
        result[iid] = candidates[0]

    cache.set(_CATEGORY_MAP_KEY, result, timeout=_CACHE_TTL)
    return result


def build_ingredient_product_map():
    """Return {ingredient_id: primary_product_name} derived from Recipe.

    Primary product = the product that uses this ingredient most often.
    Ties broken alphabetically so the sort is stable across requests.
    Cached in-process for 30 minutes.
    """
    cached = cache.get(_PRODUCT_MAP_KEY)
    if cached is not None:
        return cached

    from catalog.models import Recipe

    rows = Recipe.objects.values_list("ingredient_id", "product__name")
    by_ingredient: dict[int, Counter] = {}
    for iid, name in rows:
        by_ingredient.setdefault(iid, Counter())[name] += 1

    result = {}
    for iid, counter in by_ingredient.items():
        max_count = max(counter.values())
        candidates = sorted(n for n, cnt in counter.items() if cnt == max_count)
        result[iid] = candidates[0]

    cache.set(_PRODUCT_MAP_KEY, result, timeout=_CACHE_TTL)
    return result


def invalidate_catalog_caches():
    """Call this after any Recipe or PackDefinition change to force a fresh load."""
    cache.delete_many([_CATEGORY_MAP_KEY, _PRODUCT_MAP_KEY, "reports:pack_history"])


def resolve_ingredient_group(ingredient, category_map: dict) -> str:
    """Return the display group for an ingredient.

    SUPPLY-group or PERIODIC_COUNT ingredients always go to 'Supply'.
    Others fall back to the product-category derived from their recipes.
    """
    if ingredient.group == "SUPPLY" or ingredient.tracking_mode == "PERIODIC_COUNT":
        return "Supply"
    return category_map.get(ingredient.id, "Other")
