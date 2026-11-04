#!/usr/bin/env bash
# One-time SSL setup for a prod host: issues the Let's Encrypt cert if missing,
# and installs a renewal deploy-hook so the Dockerized nginx actually picks up
# renewed certs. Safe to re-run (every step checks before acting).
#
# Run on the EC2 host, from the directory containing docker-compose.prod.yml
# and .env.prod (e.g. /home/ubuntu/OutletOS):
#   sudo bash scripts/setup-ssl-renewal.sh
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.prod.yml"
ENV_FILE="$COMPOSE_DIR/.env.prod"

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root (certbot and the renewal-hooks dir need it). Try: sudo bash $0" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo ".env.prod not found at $ENV_FILE — run this from the deploy directory." >&2
  exit 1
fi

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN= not set in $ENV_FILE." >&2
  exit 1
fi

echo "== Domain: $DOMAIN =="

if ! command -v certbot >/dev/null 2>&1; then
  echo "== Installing certbot =="
  apt-get update -y
  apt-get install -y certbot
fi

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "== No existing cert for $DOMAIN — issuing one =="
  # certbot's standalone mode needs port 80 free, which the Dockerized nginx
  # is already holding.
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" stop nginx
  certbot certonly --standalone -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" start nginx
else
  echo "== Cert for $DOMAIN already exists, skipping issuance =="
fi

echo "== Installing renewal deploy-hook (reloads the Dockerized nginx) =="
HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
HOOK_FILE="$HOOK_DIR/reload-nginx.sh"
mkdir -p "$HOOK_DIR"
cat > "$HOOK_FILE" <<EOF
#!/bin/sh
# Nginx bind-mounts /etc/letsencrypt read-only and never reloads on its own —
# a renewed cert on disk does nothing until nginx is told to pick it up.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart nginx
EOF
chmod +x "$HOOK_FILE"

if systemctl list-unit-files | grep -q '^certbot.timer'; then
  systemctl enable --now certbot.timer
  echo "== certbot.timer enabled (renewal checks run automatically twice daily) =="
else
  echo "== WARNING: no certbot.timer unit found — renewal won't run automatically." >&2
  echo "   Add a cron entry instead, e.g.: 0 3 * * * certbot renew --quiet" >&2
fi

echo "== Done. Verify with: certbot renew --dry-run =="
