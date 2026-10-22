FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
# --timeout 150: gunicorn's sync-worker default is 30s, well under how long a
# multi-page slip extraction can take (one Claude vision call reading 2+ full
# invoice pages) — without this, gunicorn kills the worker mid-request and the
# client sees a bare connection failure. Matches nginx's proxy_read_timeout.
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "150", "--access-logfile", "-", "--log-level", "info"]
