from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0003_add_recipeproductcomponent"),
    ]

    operations = [
        migrations.AddField(
            model_name="outlet",
            name="allow_staff_date_selection",
            field=models.BooleanField(
                default=True,
                help_text="Let staff choose which date to log operations for (e.g. back-entering yesterday's data).",
            ),
        ),
    ]
