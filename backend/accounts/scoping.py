from rest_framework.exceptions import PermissionDenied


def resolve_organization_id(request):
    """The organization this request should be scoped to: the caller's own
    org, or — for a platform admin (Role.ADMIN, who has none of their own) —
    whichever org they've selected via ?organization=/body organization.
    None if unresolvable (e.g. admin viewing all organizations at once)."""
    user = request.user
    if user.is_admin:
        return request.query_params.get("organization") or request.data.get("organization")
    return user.organization_id


def resolve_outlet_param(request, param_name="outlet", source="query"):
    """Read an outlet id referenced by this request, guarding against a caller
    referencing another organization's outlet by id (IDOR).

    - If the request doesn't name an outlet, falls back to the caller's own
      assigned outlet (STAFF), or the resolved organization's one-and-only
      outlet — this covers OWNER of a single-outlet org, and a platform admin
      who has picked one organization (via ?organization=) but not a specific
      outlet within it. Replaces prior hardcoded defaults.
    - If the request does name one, a platform admin (Role.ADMIN) may reference
      any outlet; anyone else's choice must belong to their own organization.

    Returns the outlet id (str/int) as resolved, or None if unresolvable —
    callers must treat None as "no scope resolved", never as "show everything",
    when the caller isn't a platform admin viewing all organizations.
    """
    user = request.user
    raw = None
    if source in ("data", "both"):
        raw = request.data.get(param_name)
    if raw is None and source in ("query", "both"):
        raw = request.query_params.get(param_name)

    if raw is None:
        if getattr(user, "outlet_id", None):
            return user.outlet_id
        org_id = resolve_organization_id(request)
        if org_id:
            from catalog.models import Outlet
            outlets = list(
                Outlet.objects.filter(organization_id=org_id, is_active=True)[:2]
            )
            if len(outlets) == 1:
                return outlets[0].id
        return None

    if user.is_admin:
        return raw

    # A user's own directly-assigned outlet is always trusted, even if their
    # `organization` field has drifted out of sync with it — this is the
    # request they'd send by default anyway, so rejecting it would just break
    # their own screens over a data-hygiene issue rather than a real IDOR.
    if getattr(user, "outlet_id", None) and str(raw) == str(user.outlet_id):
        return raw

    from catalog.models import Outlet
    if not Outlet.objects.filter(pk=raw, organization_id=user.organization_id).exists():
        raise PermissionDenied("Outlet does not belong to your organization.")
    return raw
