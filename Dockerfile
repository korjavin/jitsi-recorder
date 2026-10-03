FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY record.js ./

# ponytail: runs as root — Chromium already gets --no-sandbox from the recorder;
# a non-root user is a later polish. Run with shm_size: 1g.
ENTRYPOINT ["node", "/app/record.js"]
