from django.conf import settings
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path, re_path
from django.views.static import serve


def health(_request):
    return JsonResponse({"status": "ok"})
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from accounts.views import UserViewSet, MeView, RoleTokenObtainPairView
from catalog.views import (
    OutletViewSet,
    ProductViewSet,
    ProductPriceViewSet,
    ComboComponentViewSet,
    IngredientViewSet,
    SupplierProductAliasViewSet,
    PackDefinitionViewSet,
    RecipeViewSet,
    RecipeProductComponentViewSet,
)
from stock.views import (
    StockInRecordViewSet,
    RawStockViewSet,
    PreparationLogViewSet,
    DisplayStockViewSet,
    OperatingDayViewSet,
    PeriodicStockCheckViewSet,
)
from sales.views import (
    SalesChannelViewSet,
    ChannelPriceViewSet,
    ChannelPromotionViewSet,
    OrderLevelOfferViewSet,
    price_resolve,
)
from closing.views import DailyClosingViewSet, ChannelSettlementViewSet
from costs.views import CostCategoryViewSet, ExpenseViewSet
from finance.views import (
    FinancialAccountViewSet,
    AccountTransactionViewSet,
    AccountTransferViewSet,
    CapitalTransactionViewSet,
    AccountBalanceCheckViewSet,
)
from income.views import OtherIncomeCategoryViewSet, OtherIncomeViewSet
from reports.views import (
    pnl_report,
    settlement_report,
    dashboard_summary,
    packaging_report,
    product_performance,
    channel_breakdown,
    stock_value,
    daily_trend,
)

router = DefaultRouter()
router.register("users", UserViewSet)
router.register("outlets", OutletViewSet)
router.register("products", ProductViewSet)
router.register("product-prices", ProductPriceViewSet)
router.register("combo-components", ComboComponentViewSet)
router.register("ingredients", IngredientViewSet)
router.register("supplier-aliases", SupplierProductAliasViewSet)
router.register("pack-definitions", PackDefinitionViewSet)
router.register("recipes", RecipeViewSet)
router.register("recipe-product-components", RecipeProductComponentViewSet)
router.register("stock-in", StockInRecordViewSet)
router.register("raw-stock", RawStockViewSet)
router.register("preparation-logs", PreparationLogViewSet)
router.register("display-stock", DisplayStockViewSet)
router.register("operating-days", OperatingDayViewSet)
router.register("periodic-stock-checks", PeriodicStockCheckViewSet)
router.register("sales-channels", SalesChannelViewSet)
router.register("channel-prices", ChannelPriceViewSet)
router.register("channel-promotions", ChannelPromotionViewSet)
router.register("order-level-offers", OrderLevelOfferViewSet)
router.register("daily-closings", DailyClosingViewSet)
router.register("channel-settlements", ChannelSettlementViewSet)
router.register("cost-categories", CostCategoryViewSet)
router.register("expenses", ExpenseViewSet)
router.register("income-categories", OtherIncomeCategoryViewSet)
router.register("other-incomes", OtherIncomeViewSet)
router.register("financial-accounts", FinancialAccountViewSet, basename="financial-accounts")
router.register("account-transactions", AccountTransactionViewSet)
router.register("account-transfers", AccountTransferViewSet)
router.register("capital-transactions", CapitalTransactionViewSet)
router.register("account-balance-checks", AccountBalanceCheckViewSet)

urlpatterns = [
    path("health/", health, name="health"),
    path("admin/", admin.site.urls),
    path("api/auth/login/", RoleTokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/auth/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("api/auth/me/", MeView.as_view(), name="me"),
    path("api/price-resolve/", price_resolve, name="price_resolve"),
    path("api/reports/pnl/", pnl_report, name="pnl_report"),
    path("api/reports/settlements/", settlement_report, name="settlement_report"),
    path("api/reports/dashboard/", dashboard_summary, name="dashboard_summary"),
    path("api/reports/packaging/", packaging_report, name="packaging_report"),
    path("api/reports/product-performance/", product_performance, name="product_performance"),
    path("api/reports/channel-breakdown/", channel_breakdown, name="channel_breakdown"),
    path("api/reports/stock-value/", stock_value, name="stock_value"),
    path("api/reports/daily-trend/", daily_trend, name="daily_trend"),
    path("api/", include(router.urls)),
]

# Serve uploaded files locally.  When S3 is configured, Django's ImageField
# returns the S3 URL directly so this route is not needed.
if not settings.STORAGES["default"]["BACKEND"].endswith("S3Boto3Storage"):
    urlpatterns += [
        re_path(r"^media/(?P<path>.*)$", serve, {"document_root": settings.MEDIA_ROOT}),
    ]
