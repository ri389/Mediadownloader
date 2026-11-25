FROM node:22-slim

# Installer Python 3, ffmpeg, curl et ca-certificates
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installer la branche nightly, recommandée par yt-dlp quand les sites changent
# plus vite que la branche stable.
RUN pip3 install --break-system-packages --no-cache-dir --pre -U "yt-dlp[default,curl-cffi]" \
    && python3 -m yt_dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3847
ENV HOST=0.0.0.0
ENV GRAB_PYTHON=python3

EXPOSE 3847

CMD ["node", "server.js"]
