"""Django settings for the CP Five Star management system."""
from datetime import timedelta
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv
import os

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(key, default=False):
    return os.getenv(key, str(default)).lower() in ("1", "true", "yes", "on")


def env_list(key, default=""):
    raw = os.getenv(key, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# Must be >= 32 bytes so HS256 JWT signing doesn't warn (RFC 7518 §3.2).
SECRET_KEY = os.getenv("SECRET_KEY", "dev-insecure-change-me-not-for-production-use-32b+")
DEBUG = env_bool("DEBUG", True)
ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "localhost,127.0.0.1")
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "http://localhost:3000,http://localhost:8000")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # third party
    "rest_framework",
    "corsheaders",
    # local
    "accounts",
    "catalog",
    "stock",
    "sales",
    "closing",
    "costs",
    "income",
    "finance",
    "reports",
    "analyst",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

if os.getenv("DATABASE_URL"):
    DATABASES = {"default": dj_database_url.parse(os.environ["DATABASE_URL"], conn_max_age=600)}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Dhaka"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# ---------------------------------------------------------------------------
# Media / file storage
#
# Local (default): files saved to MEDIA_ROOT, served by Django at /media/.
# S3-compatible:   set AWS_STORAGE_BUCKET_NAME (+ credentials below) to
#                  switch automatically.  Supports AWS S3, DigitalOcean Spaces,
#                  MinIO, and any S3-compatible store via AWS_S3_ENDPOINT_URL.
#
# Required env vars for S3:
#   AWS_STORAGE_BUCKET_NAME   bucket name
#   AWS_ACCESS_KEY_ID         access key
#   AWS_SECRET_ACCESS_KEY     secret key
#
# Optional env vars for S3:
#   AWS_S3_REGION_NAME        region (default: us-east-1)
#   AWS_S3_ENDPOINT_URL       custom endpoint for non-AWS stores (e.g. MinIO)
#   AWS_S3_CUSTOM_DOMAIN      CDN / Spaces custom domain for public URLs
# ---------------------------------------------------------------------------

_S3_BUCKET = os.getenv("AWS_STORAGE_BUCKET_NAME")

if _S3_BUCKET:
    AWS_STORAGE_BUCKET_NAME  = _S3_BUCKET
    AWS_ACCESS_KEY_ID        = os.getenv("AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY    = os.getenv("AWS_SECRET_ACCESS_KEY")
    AWS_S3_REGION_NAME       = os.getenv("AWS_S3_REGION_NAME", "us-east-1")
    AWS_S3_ENDPOINT_URL      = os.getenv("AWS_S3_ENDPOINT_URL")   # None = real AWS
    AWS_S3_CUSTOM_DOMAIN     = os.getenv("AWS_S3_CUSTOM_DOMAIN")  # CDN / Spaces domain
    AWS_DEFAULT_ACL          = "private"
    AWS_S3_FILE_OVERWRITE    = False
    AWS_S3_OBJECT_PARAMETERS = {"CacheControl": "max-age=86400"}

    _media_domain = AWS_S3_CUSTOM_DOMAIN or f"s3.amazonaws.com/{_S3_BUCKET}"
    MEDIA_URL = f"https://{_media_domain}/media/"
    MEDIA_ROOT = BASE_DIR / "media"   # unused with S3 but keeps other code happy

    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
            "OPTIONS": {"location": "media"},
        },
        "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
    }
else:
    MEDIA_URL  = "/media/"
    MEDIA_ROOT = BASE_DIR / "media"

    STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Web Push / VAPID
# Generate keys once: python manage.py generate_vapid_keys
# Then copy the output into your .env file.
# ---------------------------------------------------------------------------
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")
VAPID_CLAIM_EMAIL = os.getenv("VAPID_CLAIM_EMAIL", "admin@example.com")

# ---------------------------------------------------------------------------
# WhatsApp Business Cloud API (Meta)
# WHATSAPP_VERIFY_TOKEN  — any string you choose; paste into Meta webhook config
# WHATSAPP_APP_SECRET    — App Secret from Meta App Dashboard (for signature check)
# WHATSAPP_ACCESS_TOKEN  — System User permanent token with whatsapp_business_messaging
# WHATSAPP_PHONE_NUMBER_ID — Phone Number ID from WhatsApp > API Setup in Meta Dashboard
# ---------------------------------------------------------------------------
WHATSAPP_VERIFY_TOKEN   = os.getenv("WHATSAPP_VERIFY_TOKEN", "")
WHATSAPP_APP_SECRET     = os.getenv("WHATSAPP_APP_SECRET", "")
WHATSAPP_ACCESS_TOKEN   = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
    ),
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 100,
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=12),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=14),
}

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "http://localhost:3000")
CORS_ALLOW_CREDENTIALS = True
# In local dev the Next server may land on a different port (e.g. 3001 when 3000
# is taken); allow any localhost/127.0.0.1 port so the frontend isn't CORS-blocked.
if DEBUG:
    CORS_ALLOWED_ORIGIN_REGEXES = [r"^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):\d+$"]

# ---------------------------------------------------------------------------
# Production security — only active when DEBUG=False
# ---------------------------------------------------------------------------
if not DEBUG:
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", True)
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_HSTS_SECONDS = 31536000        # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    X_FRAME_OPTIONS = "DENY"
