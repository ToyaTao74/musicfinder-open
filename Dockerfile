FROM python:3.11-slim

# node：网易云 eapi 加密脚本运行时；xvfb：虚拟显示（抖音取证 headful 浏览器）
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates xvfb libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 fonts-liberation \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt patchright \
 && python -m patchright install chromium \
 && python -m patchright install-deps chromium

COPY . .

ENV MF_HOST=0.0.0.0 \
    PORT=3000 \
    MF_RELOADER=0 \
    MF_BATCH_WORKERS=1
EXPOSE 3000

# xvfb-run：为 headful 浏览器提供虚拟显示（抖音取证反滑块）
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x900x24", "python", "-u", "app.py"]
