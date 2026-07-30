from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0004_outlet_staff_feature_flags"),
    ]

    operations = [
        migrations.AddField(
            model_name="recipe",
            name="is_primary",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Designates this ingredient as the pack-size reference for multi-ingredient products. "
                    "When set, PACK-mode prep uses this ingredient's pack definition to compute pieces prepared; "
                    "all other ingredients are deducted proportionally. At most one per product."
                ),
            ),
        ),
    ]
