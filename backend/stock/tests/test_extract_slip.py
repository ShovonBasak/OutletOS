"""Regression tests for StockInRecordViewSet.extract:
1. invoice_number must be overwritten on every successful extraction (not
   just when currently empty) — re-running "Auto-read from slip" (e.g. after
   replacing a blurry photo) is an explicit ask to re-read it.
2. paid_from_account auto-selects the CP supplier-credit account when the
   detected supplier name is CP Bangladesh (robust to the real "C.P Bangladesh"
   punctuation), and Shop Cash for anything else — but only when nothing's
   already chosen, so it never overrides a manual pick.

Run with: python manage.py test stock.tests.test_extract_slip
"""
import datetime
import tempfile
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APIClient, APITestCase

from catalog.models import Organization, Outlet
from finance.models import FinancialAccount
from stock.models import StockInRecord

User = get_user_model()

# 1x1 transparent PNG — enough for the view to open/read as a file; the
# actual bytes are never inspected (ai_extraction is mocked below).
_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class ExtractSlipTests(APITestCase):
    def setUp(self):
        # finance's seeded default accounts (migration 0002) get backfilled onto
        # this default org (migration 0007) — reuse it so our outlet/staff and
        # those seeded accounts are in the same tenant, as extract()'s
        # organization-scoped account lookup requires.
        self.org = Organization.objects.get(slug="cp-five-star")
        self.outlet = Outlet.objects.create(name="Test Outlet", organization=self.org)
        self.staff = User.objects.create_user(
            phone="01700000401", password="x", name="Test Staff", role="STAFF",
            outlet=self.outlet, organization=self.org,
        )
        # finance/migrations/0002 seeds a default "CP Supplier Credit" account
        # already — reuse the seeded rows (same ones extract()'s query resolves
        # to in production) rather than creating name-colliding duplicates.
        FinancialAccount.objects.filter(is_primary_cash=True).update(is_primary_cash=False)
        self.shop_cash, _ = FinancialAccount.objects.get_or_create(
            account_type="CASH", name="Shop Cash",
            defaults={"opening_balance": Decimal("0"), "opening_balance_date": datetime.date(2026, 1, 1)},
        )
        self.shop_cash.is_primary_cash = True
        self.shop_cash.save(update_fields=["is_primary_cash"])
        self.cp_credit = FinancialAccount.objects.filter(
            account_type="SUPPLIER_CREDIT", name__icontains="CP"
        ).first()
        if not self.cp_credit:
            self.cp_credit = FinancialAccount.objects.create(
                account_type="SUPPLIER_CREDIT", name="CP Supplier Credit",
                opening_balance=Decimal("0"), opening_balance_date=datetime.date(2026, 1, 1),
            )
        self.client = APIClient()
        self.client.force_authenticate(user=self.staff)

        create_resp = self.client.post(
            "/api/stock-in/",
            {"outlet": self.outlet.id, "stock_in_date": "2026-01-15", "items": []},
            format="json",
        )
        self.record_id = create_resp.data["id"]
        self.client.post(
            f"/api/stock-in/{self.record_id}/upload-slip/",
            {"slip_image": SimpleUploadedFile("slip.png", _TINY_PNG, content_type="image/png")},
            format="multipart",
        )

    def _extract(self, invoice_number, supplier_name):
        with patch(
            "catalog.ai_extraction.extract_historic_stock_in",
            return_value={
                "invoice_number": invoice_number, "supplier_name": supplier_name,
                "date": None, "subtotal": None, "vat_total": None, "grand_total": None,
                "items": [],
            },
        ):
            return self.client.post(f"/api/stock-in/{self.record_id}/extract/")

    def test_invoice_number_overwritten_on_re_extract(self):
        resp = self._extract("INV-OLD-001", "Some Other Supplier")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["invoice_number"], "INV-OLD-001")

        # Re-extract with a corrected number (e.g. staff replaced a blurry photo).
        resp = self._extract("INV-CORRECTED-002", "Some Other Supplier")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["invoice_number"], "INV-CORRECTED-002")

    def test_cp_supplier_selects_supplier_credit_account(self):
        resp = self._extract("INV-001", "C.P Bangladesh Co., Ltd.")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["paid_from_account"], self.cp_credit.id)

    def test_other_supplier_selects_shop_cash(self):
        resp = self._extract("INV-002", "ACI Foods Ltd")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["paid_from_account"], self.shop_cash.id)

    def test_does_not_override_manually_chosen_account(self):
        record = StockInRecord.objects.get(pk=self.record_id)
        record.paid_from_account = self.shop_cash
        record.save(update_fields=["paid_from_account"])

        resp = self._extract("INV-003", "C.P Bangladesh Co., Ltd.")
        self.assertEqual(resp.status_code, 200, resp.data)
        # Stays Shop Cash even though the slip is CP — a manual choice wins.
        self.assertEqual(resp.data["paid_from_account"], self.shop_cash.id)
