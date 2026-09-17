FROM node:20-slim

# Installer Python 3, ffmpeg et les dépendances nécessaires
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Installer yt-dlp dans l'environnement Python
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

# Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install --production

# Copier le reste du code source
COPY . .

# Configuration des variables d'environnement
ENV PORT=3847
ENV GRAB_PYTHON=python3

EXPOSE 3847

CMD ["node", "server.js"]
