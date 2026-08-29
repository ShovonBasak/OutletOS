"""WhatsApp webhook + order-suggestion API for the CP Five Star analyst.

WhatsApp flow:
  - General questions → build data snapshot → call Claude → reply
  - Order commands ("order", "what to order", "order thursday" …) → compute
    order suggestion deterministically (no Claude token cost) → reply with
    formatted ingredient list the owner can copy into their supplier chat

Order suggestion API:
  GET /api/analyst/order-suggestion/?delivery_date=YYYY-MM-DD&outlet=<id>
  Returns JSON including a whatsapp_text field ready to copy.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import date as date_type

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrAdmin
from .context import build_system_prompt
from .models import AnalystConversation
from .tools import TOOL_SCHEMAS, execute_tool
from .ordering import (
    DELIVERY_WEEKDAYS,
    compute_order_suggestion,
    next_delivery_dates,
)
from .whatsapp import send_message, verify_signature

logger = logging.getLogger(__name__)

MAX_HISTORY = 20        # user/assistant turns stored (tool intermediaries not saved)
HISTORY_TTL_HOURS = 8   # reset conversation after this many idle hours
MAX_TOOL_ROUNDS = 6     # max tool-call cycles per message before forcing a response

# ── Order-intent detection ────────────────────────────────────────────────────

_ORDER_RE = re.compile(
    r"\border[\s-]?(suggest|plan|list|items?|quantit|how much|what)?"
    r"|\bwhat.{0,30}(order|buy|purchase|get)\b"
    r"|\bplace.{0,15}order\b"
    r"|\bstock.{0,10}up\b"
    r"|\bdelivery list\b"
    r"|\bkoto order\b"      # Bengali transliteration
    r"|\bki order\b",
    re.IGNORECASE,
)

_DAY_RE = re.compile(
    r"\b(sun(?:day)?|tue(?:s(?:day)?)?|thu(?:rs(?:day)?)?)\b",
    re.IGNORECASE,
)
_ISO_DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")

_DAY_MAP: dict[str, int] = {
    "sun": 6, "sunday": 6,
    "tue": 1, "tues": 1, "tuesday": 1,
    "thu": 3, "thurs": 3, "thursday": 3,
}


def _parse_delivery_date(text: str) -> date_type | None:
    """Extract delivery date from free text. Returns None if not found/invalid."""
    iso_match = _ISO_DATE_RE.search(text)
    if iso_match:
        try:
            d = date_type.fromisoformat(iso_match.group(1))
            if d.weekday() in DELIVERY_WEEKDAYS:
                return d
        except ValueError:
            pass

    day_match = _DAY_RE.search(text)
    if day_match:
        target_wd = _DAY_MAP.get(day_match.group(1).lower())
        if target_wd is not None:
            for d in next_delivery_dates(date_type.today(), 5):
                if d.weekday() == target_wd:
                    return d
    return None


# ── Shared helpers ────────────────────────────────────────────────────────────

def _load_conversation(phone: str) -> AnalystConversation:
    conv, _ = AnalystConversation.objects.get_or_create(phone_number=phone)
    if conv.updated_at:
        idle_hours = (timezone.now() - conv.updated_at).total_seconds() / 3600
        if idle_hours > HISTORY_TTL_HOURS:
            conv.messages = []
            conv.save(update_fields=["messages"])
    return conv


def _resolve_outlet(user) -> int | None:
    if getattr(user, "outlet_id", None):
        return user.outlet_id
    try:
        from catalog.models import Outlet
        return Outlet.objects.filter(is_active=True).values_list("id", flat=True).first()
    except Exception:
        return None


def _normalize_phone(raw: str) -> str:
    return "".join(c for c in raw if c.isdigit())


def _find_owner(from_phone: str):
    from accounts.models import Role, User
    suffix = _normalize_phone(from_phone)[-11:]  # Bangladesh: 11-digit local format
    return User.objects.filter(
        phone__endswith=suffix,
        role__in=[Role.OWNER, Role.ADMIN],
        is_active=True,
    ).first()


def _call_claude(system: str, messages: list, outlet_id=None) -> str:
    """Run Claude with tool use. Executes tool calls in a loop until end_turn."""
    from catalog.ai_extraction import LLMUnavailable, _client
    try:
        client = _client()
        working = list(messages)  # copy — tool intermediaries stay out of saved history
        resp = None

        for _ in range(MAX_TOOL_ROUNDS):
            resp = client.messages.create(
                model=getattr(settings, "CLAUDE_MODEL", "claude-sonnet-4-6"),
                max_tokens=1024,
                system=system,
                messages=working,
                tools=TOOL_SCHEMAS,
            )

            if resp.stop_reason == "end_turn":
                parts = [b.text for b in resp.content if hasattr(b, "text") and b.text]
                return " ".join(parts) if parts else "No response."

            if resp.stop_reason == "tool_use":
                working.append({"role": "assistant", "content": resp.content})
                results = []
                for block in resp.content:
                    if block.type == "tool_use":
                        logger.info("analyst tool call: %s %s", block.name, block.input)
                        result = execute_tool(block.name, block.input, outlet_id)
                        results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result,
                        })
                working.append({"role": "user", "content": results})
            else:
                break  # max_tokens or unexpected stop reason

        # Exhausted rounds — extract whatever text is available
        if resp and resp.content:
            parts = [b.text for b in resp.content if hasattr(b, "text") and b.text]
            if parts:
                return " ".join(parts)
        return "Analysis took too long. Please ask a more specific question."

    except LLMUnavailable as exc:
        return f"AI analyst temporarily unavailable: {exc}"
    except Exception as exc:
        logger.error("Claude call failed: %s", exc)
        return "Something went wrong. Please try again in a moment."


# ── Background message processor ─────────────────────────────────────────────

def _handle_order_command(from_phone: str, text: str, user) -> bool:
    """If text is an order request, compute suggestion and reply. Returns True if handled."""
    if not _ORDER_RE.search(text):
        return False

    outlet_id = _resolve_outlet(user)
    delivery_date = _parse_delivery_date(text) or next_delivery_dates(date_type.today(), 1)[0]

    try:
        result = compute_order_suggestion(delivery_date, outlet_id)
        reply = result["whatsapp_text"]
        confidence = result["data_quality"]["confidence"]
        if confidence == "Low":
            reply += f"\n\n⚠ _Confidence: Low ({result['data_quality']['operating_days_analyzed']} operating days analysed — more history improves accuracy)_"
    except Exception as exc:
        logger.error("order_suggestion failed for %s: %s", from_phone, exc)
        reply = "Sorry, I couldn't generate the order suggestion right now. Please try again."

    send_message(from_phone, reply)
    return True


def _process_message(from_phone: str, text: str, user) -> None:
    """Run in a background thread: route to order handler or Claude analyst."""
    try:
        # Order commands are handled deterministically — no Claude token cost
        if _handle_order_command(from_phone, text, user):
            return

        # General question → build snapshot + call Claude
        outlet_id = _resolve_outlet(user)
        system_prompt = build_system_prompt(outlet_id)

        conv = _load_conversation(from_phone)
        history = list(conv.messages)
        history.append({"role": "user", "content": text})

        reply = _call_claude(system_prompt, history[-MAX_HISTORY:], outlet_id)

        history.append({"role": "assistant", "content": reply})
        conv.messages = history[-MAX_HISTORY:]
        conv.save()

        send_message(from_phone, reply)
    except Exception as exc:
        logger.error("analyst._process_message failed for %s: %s", from_phone, exc)
        send_message(from_phone, "Sorry, I ran into an error. Please try again.")


# ── WhatsApp webhook ──────────────────────────────────────────────────────────

@csrf_exempt
def whatsapp_webhook(request):
    # GET — Meta verification challenge
    if request.method == "GET":
        mode = request.GET.get("hub.mode")
        token = request.GET.get("hub.verify_token")
        challenge = request.GET.get("hub.challenge", "")
        if mode == "subscribe" and token == getattr(settings, "WHATSAPP_VERIFY_TOKEN", ""):
            return HttpResponse(challenge, content_type="text/plain")
        return HttpResponse(status=403)

    if request.method != "POST":
        return HttpResponse(status=405)

    # Verify payload signature
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not verify_signature(request.body, sig):
        logger.warning("analyst webhook: bad signature from %s", request.META.get("REMOTE_ADDR"))
        return HttpResponse(status=403)

    # Always respond 200 immediately — Meta retries on timeout
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"status": "ok"})

    try:
        change_value = data["entry"][0]["changes"][0]["value"]
        if "messages" not in change_value:
            return JsonResponse({"status": "ok"})

        message = change_value["messages"][0]
        if message.get("type") != "text":
            return JsonResponse({"status": "ok"})

        from_phone = message["from"]
        text = message["text"]["body"].strip()
        if not text:
            return JsonResponse({"status": "ok"})
    except (KeyError, IndexError):
        return JsonResponse({"status": "ok"})

    user = _find_owner(from_phone)
    if not user:
        return JsonResponse({"status": "ok"})

    threading.Thread(
        target=_process_message,
        args=(from_phone, text, user),
        daemon=True,
    ).start()

    return JsonResponse({"status": "ok"})


# ── Order suggestion REST API ─────────────────────────────────────────────────

@api_view(["GET"])
@permission_classes([IsAuthenticated])
def order_suggestion_api(request):
    """GET /api/analyst/order-suggestion/?delivery_date=YYYY-MM-DD&outlet=<id>

    delivery_date must be a Sunday, Tuesday, or Thursday.
    Omit to default to the next upcoming delivery date.
    """
    raw_date = request.query_params.get("delivery_date")
    outlet_id = request.query_params.get("outlet") or _resolve_outlet(request.user)

    if raw_date:
        try:
            delivery_date = date_type.fromisoformat(raw_date)
        except ValueError:
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=400)
        if delivery_date.weekday() not in DELIVERY_WEEKDAYS:
            return Response(
                {"error": "Delivery date must be a Sunday, Tuesday, or Thursday."},
                status=400,
            )
    else:
        delivery_date = next_delivery_dates(date_type.today(), 1)[0]

    result = compute_order_suggestion(delivery_date, outlet_id)
    return Response(result)
