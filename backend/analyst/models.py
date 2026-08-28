from django.db import models


class AnalystConversation(models.Model):
    """Per-phone conversation history for the WhatsApp analyst. Pruned after 8 hours of
    inactivity so each new day starts with a clean slate."""

    phone_number = models.CharField(max_length=30, unique=True)
    messages = models.JSONField(default=list)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Conversation({self.phone_number})"
