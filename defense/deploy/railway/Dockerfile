FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY witness/ witness/
COPY sidecar/ sidecar/
COPY tools/ tools/
COPY deploy/railway/witness-config.toml config.toml
COPY deploy/railway/start.sh start.sh
RUN chmod 755 start.sh

EXPOSE 8800

CMD ["./start.sh"]
