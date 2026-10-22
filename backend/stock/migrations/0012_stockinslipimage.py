"""Support multiple slip page-images per StockInRecord.

CP Bangladesh invoices with a long item list are split across 2+ photographed
pages (continued item numbering, final cumulative totals on the last page).
Previously `StockInRecord.slip_image` held exactly one file; this replaces it
with a `StockInSlipImage` child table (ordered pages), migrating any existing
single image into page 0 before dropping the old field.
"""
from django.db import migrations, models
import django.db.models.deletion


def migrate_existing_slip_images(apps, schema_editor):
    StockInRecord = apps.get_model("stock", "StockInRecord")
    StockInSlipImage = apps.get_model("stock", "StockInSlipImage")

    for record in StockInRecord.objects.exclude(slip_image="").exclude(slip_image__isnull=True):
        StockInSlipImage.objects.create(
            stock_in_record_id=record.id, image=record.slip_image.name, order=0
        )


class Migration(migrations.Migration):

    dependencies = [
        ("stock", "0011_stockinrecord_updated_at"),
    ]

    operations = [
        migrations.CreateModel(
            name="StockInSlipImage",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("image", models.ImageField(upload_to="slips/")),
                ("order", models.PositiveIntegerField(default=0)),
                ("uploaded_at", models.DateTimeField(auto_now_add=True)),
                (
                    "stock_in_record",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="slip_images",
                        to="stock.stockinrecord",
                    ),
                ),
            ],
            options={"ordering": ["order", "id"]},
        ),
        migrations.RunPython(migrate_existing_slip_images, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name="stockinrecord",
            name="slip_image",
        ),
    ]
