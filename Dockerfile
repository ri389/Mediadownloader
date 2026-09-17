FROM node:20-slim

# Installer Python 3, ffmpeg, curl et ca-certificates
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Mettre à jour pip et installer la dernière version de yt-dlp
RUN pip3 install --break-system-packages --no-cache-dir -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3847
ENV GRAB_PYTHON=python3

EXPOSE 3847

CMD ["node", "server.js"]
