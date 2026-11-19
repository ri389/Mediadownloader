# Media Downloader

Application web personnelle pour analyser et télécharger des médias depuis un lien direct ou depuis des plateformes prises en charge par [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). L’interface et les messages de l’application sont en français.

## Fonctionnalités

- Analyse de liens directs vers des images, vidéos et fichiers audio.
- Récupération de médias depuis des plateformes compatibles avec `yt-dlp` (notamment YouTube, TikTok, Instagram, Pinterest, X, Facebook, Vimeo, Dailymotion, Reddit, SoundCloud et Twitch).
- Choix de la résolution et du conteneur vidéo, ou extraction audio dans différents formats.
- Prévisualisation et suivi de la progression des téléchargements.
- Limite de taille des fichiers : 500 Mo.

La disponibilité peut varier selon le site, ses restrictions et la version de `yt-dlp`. Les contenus privés ou protégés peuvent ne pas être accessibles.

## Prérequis

- Node.js 20 ou version ultérieure.
- Python 3.
- `yt-dlp` installé et disponible via Python (`python3 -m yt_dlp`) ou comme commande `yt-dlp`.
- FFmpeg pour fusionner certains flux vidéo et convertir l’audio.

## Lancer l’application

```bash
npm start
```

Puis ouvrez <http://localhost:3847> dans votre navigateur. Le port peut être remplacé en définissant la variable d’environnement `PORT`.

### Installer les outils requis

Installez Python 3 et FFmpeg avec le gestionnaire de paquets de votre système, puis installez ou mettez à jour `yt-dlp` :

```bash
python3 -m pip install -U yt-dlp
```

Si nécessaire, indiquez le chemin de l’interpréteur Python avec `GRAB_PYTHON`, ou celui du dossier contenant FFmpeg avec `FFMPEG_DIR`.

## Docker

Le dépôt contient un `Dockerfile` qui installe Node.js, Python, FFmpeg et `yt-dlp` :

```bash
docker build -t media-downloader .
docker run --rm -p 3847:3847 media-downloader
```

L’application sera disponible sur <http://localhost:3847>.

## Cookies (facultatif)

Certains sites, notamment YouTube, peuvent nécessiter des cookies. Le serveur recherche les cookies dans l’ordre suivant :

1. `YTDLP_COOKIES_B64` : contenu du fichier de cookies encodé en Base64 (pratique pour un déploiement).
2. `YTDLP_COOKIES` : chemin vers un fichier de cookies.
3. Un fichier `cookies.txt` placé à côté de `server.js`.

Gardez vos cookies secrets : ne les publiez pas et ne les ajoutez pas au dépôt. Le fichier `cookies.txt` doit rester local ou être fourni de manière sécurisée à l’environnement d’exécution.

## Utilisation responsable

Utilisez cette application uniquement pour télécharger du contenu que vous êtes autorisé à récupérer. Respectez les droits d’auteur, les conditions d’utilisation des sites concernés et la législation applicable. Ne partagez pas publiquement un déploiement sans avoir évalué les risques liés à son accès et à son utilisation.
