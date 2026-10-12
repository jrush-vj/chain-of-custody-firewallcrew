# Small Python image for witness service
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY witness/ witness/
COPY sidecar/ sidecar/
COPY tools/ tools/

EXPOSE 8800

CMD ["python", "-m", "witness.app", "--config", "config.toml", "--host", "0.0.0.0"]
