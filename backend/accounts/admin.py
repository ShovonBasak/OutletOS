from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.forms import UserChangeForm, UserCreationForm
from django import forms

from .models import User


class PhoneUserCreationForm(UserCreationForm):
    class Meta:
        model = User
        fields = ("phone", "name", "role", "organization", "outlet")


class PhoneUserChangeForm(UserChangeForm):
    class Meta:
        model = User
        fields = "__all__"


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    form = PhoneUserChangeForm
    add_form = PhoneUserCreationForm

    list_display = ["name", "phone", "role", "organization", "outlet", "is_active"]
    list_filter = ["role", "organization", "is_active"]
    search_fields = ["name", "phone"]
    ordering = ["phone"]

    fieldsets = (
        (None, {"fields": ("phone", "password")}),
        ("Personal info", {"fields": ("name", "role", "organization", "outlet")}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser")}),
    )
    add_fieldsets = (
        (None, {
            "classes": ("wide",),
            "fields": ("phone", "name", "role", "organization", "outlet", "password1", "password2"),
        }),
    )
