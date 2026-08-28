"""WhatsApp Cloud API client — send messages and verify webhook signatures."""
from __future__ import annotations

import hashlib
import hmac
import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

_GRAPH_URL = "https://graph.facebook.com/v20.0"


def verify_signature(payload: bytes, header_value: str) -> bool:
    """Return True when the X-Hub-Signature-256 header matches the payload.
    Skips verification in dev mode (APP_SECRET not set)."""
    secret = getattr(settings, "WHATSAPP_APP_SECRET", "")
    if not secret:
        return True
    expected = "sha256=" + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header_value)


def send_message(to: str, text: str) -> bool:
    """Send a plain-text WhatsApp message. Returns True on success."""
    phone_number_id = getattr(settings, "WHATSAPP_PHONE_NUMBER_ID", "")
    access_token = getattr(settings, "WHATSAPP_ACCESS_TOKEN", "")
    if not phone_number_id or not access_token:
        logger.error("WhatsApp not configured — set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN")
        return False

    url = f"{_GRAPH_URL}/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
    try:
        resp = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        logger.error("WhatsApp send to %s failed: %s", to, exc)
        return False
