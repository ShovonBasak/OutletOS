class OrgScopedQuerySetMixin:
    """Confines a ViewSet's queryset to the caller's Organization (tenant).

    `org_lookup` is the ORM path from this model to Organization — "organization"
    for a direct FK, or a relation chain like "product__organization" /
    "outlet__organization" for models that scope transitively.

    Role.ADMIN is the platform-admin role (organization=None): it sees every
    organization by default, or can narrow to one via ?organization=<id>.
    OWNER/STAFF only ever see their own organization's rows.
    """

    org_lookup = "organization"

    def scope_queryset(self, qs):
        user = self.request.user
        if not (user and user.is_authenticated):
            return qs.none()
        if user.is_admin:
            org_param = self.request.query_params.get("organization")
            if org_param:
                qs = qs.filter(**{f"{self.org_lookup}_id": org_param})
            return qs
        if user.organization_id is None:
            return qs.none()
        return qs.filter(**{f"{self.org_lookup}_id": user.organization_id})

    def get_queryset(self):
        return self.scope_queryset(super().get_queryset())


class OrganizationOwnedMixin(OrgScopedQuerySetMixin):
    """For models with a direct `organization` FK: auto-stamps it on create from
    the caller's own organization, so callers never need to pass it explicitly.
    A platform admin (Role.ADMIN) must pass ?organization=<id> (or organization
    in the body) since they have none of their own."""

    org_lookup = "organization"

    def resolve_organization(self):
        """The Organization new rows created by this request should belong to:
        the caller's own org, or — for a platform admin — whichever org they
        pointed at via ?organization=/body organization. None if unresolvable."""
        user = self.request.user
        org = getattr(user, "organization", None)
        if org is None and getattr(user, "is_admin", False):
            org_id = (
                self.request.query_params.get("organization")
                or self.request.data.get("organization")
            )
            if org_id:
                from catalog.models import Organization
                org = Organization.objects.filter(pk=org_id).first()
        return org

    def perform_create(self, serializer):
        if "organization" not in serializer.validated_data:
            org = self.resolve_organization()
            if org is not None:
                serializer.save(organization=org)
                return
        serializer.save()
