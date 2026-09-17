FROM python:3.11-slim

# node：网易云 eapi 加密脚本运行时
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV MF_HOST=0.0.0.0 \
    PORT=3000 \
    MF_RELOADER=0 \
    MF_BATCH_WORKERS=1
EXPOSE 3000

CMD ["python", "-u", "app.py"]
