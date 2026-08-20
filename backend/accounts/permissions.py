from rest_framework.permissions import BasePermission, SAFE_METHODS


class IsOwner(BasePermission):
    """Only OWNER role. Kept for backward-compat during migration."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_owner)


class IsAdmin(BasePermission):
    """Only ADMIN role."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_admin)


class IsOwnerOrAdmin(BasePermission):
    """OWNER or ADMIN — both can perform this action."""

    def has_permission(self, request, view):
        return bool(
            request.user and request.user.is_authenticated and request.user.is_owner_or_admin
        )


class IsOwnerOrReadOnly(BasePermission):
    """Any authenticated user can read; only OWNER can write. Kept for backward-compat."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_owner


class IsOwnerOrAdminOrReadOnly(BasePermission):
    """Any authenticated user can read; OWNER or ADMIN can write."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_owner_or_admin


class IsAdminOrReadOnly(BasePermission):
    """Any authenticated user can read; only ADMIN can write."""

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_admin
