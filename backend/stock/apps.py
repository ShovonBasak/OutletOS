from django.apps import AppConfig


class StockConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "stock"

    def ready(self):
        # Teach Pillow to open iPhone HEIC/HEIF slips (for both ImageField
        # validation on upload and OCR). No-op if the lib isn't installed.
        try:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        except Exception:
            pass
