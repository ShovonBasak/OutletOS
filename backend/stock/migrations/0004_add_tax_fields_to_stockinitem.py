from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('stock', '0003_add_price_fields_to_stockin'),
    ]

    operations = [
        # Extend unit_price precision (was 10,2 — now 10,4 for line_total÷qty)
        migrations.AlterField(
            model_name='stockinitem',
            name='unit_price',
            field=models.DecimalField(blank=True, decimal_places=4, max_digits=10, null=True),
        ),
        # Extend line_total precision (12 digits for large invoices)
        migrations.AlterField(
            model_name='stockinitem',
            name='line_total',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
        # Pre-tax per unit price (from "Per Unit Price" column)
        migrations.AddField(
            model_name='stockinitem',
            name='rate',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True),
        ),
        # Pre-tax line subtotal = quantity × rate ("Total Amount" column)
        migrations.AddField(
            model_name='stockinitem',
            name='total_amount',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
        # Supplementary Duty rate (%)
        migrations.AddField(
            model_name='stockinitem',
            name='sd_rate',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=6, null=True),
        ),
        # Supplementary Duty amount (BDT)
        migrations.AddField(
            model_name='stockinitem',
            name='sd_amount',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
        # VAT rate (%)
        migrations.AddField(
            model_name='stockinitem',
            name='vat_rate',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=6, null=True),
        ),
        # VAT amount (BDT)
        migrations.AddField(
            model_name='stockinitem',
            name='vat_amount',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True),
        ),
    ]
