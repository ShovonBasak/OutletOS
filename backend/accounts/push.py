"""Web Push notification helpers."""

import json
import logging

from django.conf import settings

logger = logging.getLogger(__name__)


def send_push_to_owners(title: str, body: str, url: str = "/owner/stock-in") -> None:
    """Send a push notification to every owner user with an active subscription.

    Silently skips if VAPID keys are not configured or pywebpush is missing.
    Expired/unregistered subscriptions (HTTP 404/410) are deleted automatically.
    """
    if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY:
        return

    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("pywebpush not installed — push notifications skipped")
        return

    from .models import PushSubscription, Role

    subs = list(PushSubscription.objects.filter(user__role=Role.OWNER).select_related("user"))
    if not subs:
        return

    payload = json.dumps({"title": title, "body": body, "url": url})
    vapid_claims = {"sub": f"mailto:{settings.VAPID_CLAIM_EMAIL}"}

    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_claims=vapid_claims,
            )
        except WebPushException as exc:
            resp = getattr(exc, "response", None)
            if resp is not None and resp.status_code in (404, 410):
                sub.delete()
                logger.info("Removed expired push subscription %s", sub.id)
            else:
                logger.error("Push failed for subscription %s: %s", sub.id, exc)
        except Exception as exc:
            logger.error("Unexpected push error for subscription %s: %s", sub.id, exc)
