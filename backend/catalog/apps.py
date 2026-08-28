from django.apps import AppConfig


class CatalogConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "catalog"

    def ready(self):
        from django.db.models.signals import post_save, post_delete
        from django.dispatch import receiver
        from catalog.models import Recipe, PackDefinition
        from catalog.utils import invalidate_catalog_caches

        for signal in (post_save, post_delete):
            signal.connect(lambda sender, **kw: invalidate_catalog_caches(), sender=Recipe, weak=False)
            signal.connect(lambda sender, **kw: invalidate_catalog_caches(), sender=PackDefinition, weak=False)
