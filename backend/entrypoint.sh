#!/usr/bin/env bash
set -e

# Wait for Postgres (compose also gates on a healthcheck, this is a belt-and-braces).
if [ -n "$DATABASE_URL" ]; then
  echo "Waiting for database…"
  python - <<'PY'
import os, time, sys
import dj_database_url
import psycopg2

cfg = dj_database_url.parse(os.environ["DATABASE_URL"])
for attempt in range(30):
    try:
        psycopg2.connect(
            dbname=cfg["NAME"], user=cfg["USER"], password=cfg["PASSWORD"],
            host=cfg["HOST"], port=cfg["PORT"] or 5432,
        ).close()
        print("Database is ready.")
        sys.exit(0)
    except Exception as exc:
        print(f"  ({attempt + 1}/30) not ready: {exc}")
        time.sleep(2)
print("Database never became ready.", file=sys.stderr)
sys.exit(1)
PY
fi

echo "Applying migrations…"
python manage.py migrate --noinput

echo "Collecting static files…"
python manage.py collectstatic --noinput

echo "Seeding demo data (idempotent)…"
python manage.py seed || echo "Seed step skipped/failed (non-fatal)."

exec "$@"
