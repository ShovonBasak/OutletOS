from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="AnalystConversation",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("phone_number", models.CharField(max_length=30, unique=True)),
                ("messages", models.JSONField(default=list)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
        ),
    ]
