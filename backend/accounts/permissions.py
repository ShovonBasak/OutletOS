from rest_framework.permissions import BasePermission, SAFE_METHODS


class IsOwner(BasePermission):
    """Only OWNER role."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_owner)


class IsAdmin(BasePermission):
    """Only ADMIN role — the cross-org platform-admin surface: Organization
    CRUD, TenantApplication review, cross-org user administration,
    AccountTransaction.destroy (an audit safety net, kept admin-only on
    purpose). ADMIN is not a per-tenant operational role — it does not
    manage any single organization's stock, sales, or financial data; see
    IsOwnerFullAdminReadOnly / IsStaffOwnerFullAdminReadOnly for those, where
    ADMIN gets read-only support visibility instead. See IsAdminOrReadOnly
    for the global catalog, which ADMIN does manage."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_admin)


class IsOwnerOrAdmin(BasePermission):
    """OWNER or ADMIN — both can perform this action. Reserved for the
    handful of places ADMIN legitimately still acts on tenant data as a
    platform-support function (e.g. managing any user's account via
    TeamUserViewSet). Prefer IsOwnerFullAdminReadOnly for tenant business
    data, where ADMIN should only read, not write."""

    def has_permission(self, request, view):
        return bool(
            request.user and request.user.is_authenticated and request.user.is_owner_or_admin
        )


class IsStaffOwnerFullAdminReadOnly(BasePermission):
    """STAFF or OWNER get full access to the gated daily-flow endpoints
    (Day-Start, Stock In, Prep, Closing) — OWNER is included deliberately:
    the "Staff view" toggle lets them use these same screens/endpoints to
    fix a staff mistake, under their own identity (every actor field on
    these models — started_by, submitted_by, logged_by, staff — just
    records whoever is logged in, so this stays honestly attributed).
    ADMIN can read (list/retrieve) for support/debugging but cannot write —
    day-to-day tenant operations are outside ADMIN's platform-config scope."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            return False
        if user.is_staff_role or user.is_owner:
            return True
        if user.is_admin:
            return request.method in SAFE_METHODS
        return False


class IsOwnerOrReadOnly(BasePermission):
    """Any authenticated user can read; only OWNER can write."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_owner


class IsAdminOrReadOnly(BasePermission):
    """Any authenticated user (OWNER/STAFF/ADMIN, across every organization)
    can read; only ADMIN can write. For the global catalog — Product,
    Ingredient, Recipe, pricing, cost/income types — which is deliberately
    NOT organization-scoped: every franchise outlet sells the same menu at
    the same recipe/price, so it's one shared, admin-managed source of
    truth rather than per-tenant rows."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_admin


class IsOwnerFullAdminReadOnly(BasePermission):
    """OWNER has full read/write over their own organization's data. ADMIN
    can read (list/retrieve) any organization's data for support/debugging,
    but never write — tenant business operations (finance, approvals,
    settlements) are outside ADMIN's platform-config scope. STAFF has no
    access."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated):
            return False
        if user.is_owner:
            return True
        if user.is_admin:
            return request.method in SAFE_METHODS
        return False
