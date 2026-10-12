# Small Python image for sidecar service
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sidecar/ sidecar/
COPY tools/ tools/
COPY verifier/ verifier/

CMD ["python", "-m", "sidecar.main", "--config", "config.toml"]
