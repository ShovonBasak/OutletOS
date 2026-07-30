"""Unit tests for ocr.matcher — ProductMatcher."""
import unittest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from django.conf import settings
if not settings.configured:
    settings.configure(INSTALLED_APPS=[], DATABASES={})

try:
    import rapidfuzz  # noqa: F401
    _RAPIDFUZZ_AVAILABLE = True
except ImportError:
    _RAPIDFUZZ_AVAILABLE = False

from ocr.matcher import ProductMatcher


_CATALOG = [
    "Chicken Pop Stick FPP Chilled",
    "Burger Bun 6pcs",
    "French Fry Crinkle Cut",
    "Mayo Sauce Small Pack",
    "Drinking Water 500ml",
]


@unittest.skipUnless(_RAPIDFUZZ_AVAILABLE, "rapidfuzz not installed")
class TestProductMatcher(unittest.TestCase):

    def setUp(self):
        self.matcher = ProductMatcher(_CATALOG)

    def test_exact_match(self):
        name, score = self.matcher.match("Chicken Pop Stick FPP Chilled")
        self.assertEqual(name, "Chicken Pop Stick FPP Chilled")
        self.assertGreater(score, 99.0)

    def test_typo_match(self):
        """OCR produces 'Chicken Pop Stck' — should still match."""
        name, score = self.matcher.match("Chicken Pop Stck")
        self.assertEqual(name, "Chicken Pop Stick FPP Chilled")
        self.assertGreater(score, 60.0)

    def test_partial_name(self):
        name, score = self.matcher.match("Burger Bun")
        self.assertEqual(name, "Burger Bun 6pcs")
        self.assertGreater(score, 60.0)

    def test_no_match_below_threshold(self):
        """Completely unrelated string should return no match."""
        matcher = ProductMatcher(_CATALOG, min_score=90.0)
        name, score = matcher.match("zzz xyz abc 123")
        self.assertEqual(name, "")
        self.assertEqual(score, 0.0)

    def test_empty_ocr_name(self):
        name, score = self.matcher.match("")
        self.assertEqual(name, "")
        self.assertEqual(score, 0.0)

    def test_empty_catalog(self):
        matcher = ProductMatcher([])
        name, score = matcher.match("Chicken Pop Stick")
        self.assertEqual(name, "")
        self.assertEqual(score, 0.0)

    def test_match_all(self):
        results = self.matcher.match_all(["Chicken Pop Stck", "Burger Bun"])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0][0], "Chicken Pop Stick FPP Chilled")
        self.assertEqual(results[1][0], "Burger Bun 6pcs")

    def test_catalog_property(self):
        self.assertEqual(self.matcher.catalog, _CATALOG)


class TestProductMatcherNoRapidfuzz(unittest.TestCase):

    def test_raises_import_error_when_rapidfuzz_missing(self):
        """If rapidfuzz is not installed, match() raises ImportError (not AttributeError)."""
        import sys
        original = sys.modules.get("rapidfuzz")
        sys.modules["rapidfuzz"] = None  # type: ignore[assignment]
        try:
            matcher = ProductMatcher(["X"])
            with self.assertRaises((ImportError, TypeError)):
                matcher.match("something")
        finally:
            if original is None:
                del sys.modules["rapidfuzz"]
            else:
                sys.modules["rapidfuzz"] = original


if __name__ == "__main__":
    unittest.main()
