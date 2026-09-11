import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0009_backfill_promotion_organization"),
    ]

    operations = [
        migrations.AlterField(
            model_name="channelpromotion",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="channel_promotions", to="catalog.organization"),
        ),
        migrations.AlterField(
            model_name="orderleveloffer",
            name="organization",
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="order_level_offers", to="catalog.organization"),
        ),
    ]
