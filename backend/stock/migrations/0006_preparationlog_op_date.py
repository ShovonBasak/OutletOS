from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("stock", "0005_add_invoice_number_to_stockin"),
    ]

    operations = [
        migrations.AddField(
            model_name="preparationlog",
            name="op_date",
            field=models.DateField(
                blank=True,
                null=True,
                help_text="Operational date this log belongs to (may differ from timestamp when back-entering data).",
            ),
        ),
    ]
