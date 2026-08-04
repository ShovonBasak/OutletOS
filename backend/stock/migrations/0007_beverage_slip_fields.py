from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("stock", "0006_preparationlog_op_date"),
    ]

    operations = [
        # StockInRecord — slip-level discount total (e.g. beverage challan footer)
        migrations.AddField(
            model_name="stockinrecord",
            name="slip_discount_total",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
        # StockInItem — supplier SKU code (reference only)
        migrations.AddField(
            model_name="stockinitem",
            name="sku_code",
            field=models.CharField(blank=True, max_length=50),
        ),
        # StockInItem — MRP per piece (reference only)
        migrations.AddField(
            model_name="stockinitem",
            name="mrp",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True),
        ),
        # StockInItem — per-line discount amount (used by beverage slips)
        migrations.AddField(
            model_name="stockinitem",
            name="discount",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
    ]
