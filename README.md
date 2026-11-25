# Media Downloader

Application web personnelle pour analyser et télécharger des médias depuis un lien direct ou depuis des plateformes prises en charge par [`yt-dlp`](https://github.com/yt-dlp/yt-dlp). L’interface et les messages de l’application sont en français.

## Fonctionnalités

- Analyse de liens directs vers des images, vidéos et fichiers audio.
- Récupération de médias depuis des plateformes compatibles avec `yt-dlp` (notamment YouTube, TikTok, Instagram, Pinterest, X, Facebook, Vimeo, Dailymotion, Reddit, SoundCloud et Twitch).
- Choix de la résolution et du conteneur vidéo, ou extraction audio dans différents formats.
- Prévisualisation et suivi de la progression des téléchargements.
- Comptes utilisateur avec connexion, inscription et gestion du profil.
- Limite de taille des fichiers : 500 Mo.

La disponibilité peut varier selon le site, ses restrictions et la version de `yt-dlp`. Les contenus privés ou protégés peuvent ne pas être accessibles.

## Prérequis

- Node.js 22 ou version ultérieure.
- PostgreSQL 16 ou version ultérieure.
- Python 3.
- `yt-dlp` installé et disponible via Python (`python3 -m yt_dlp`) ou comme commande `yt-dlp`.
- FFmpeg pour fusionner certains flux vidéo et convertir l’audio.

## Lancer l’application

Le serveur a besoin d’une base PostgreSQL et charge automatiquement `.env`. Pour développer avec Node.js sur la machine et PostgreSQL dans Docker, copie `.env.example` vers `.env`, remplace les secrets, puis lance :

```powershell
docker compose up -d postgres
npm install
npm start
```

L’application Node se connectera au service PostgreSQL sur `127.0.0.1:5433`. `POSTGRES_PASSWORD` fournit le mot de passe DB local si `PGPASSWORD` n’est pas défini. Si tu utilises une autre base, ajuste `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` et `PGPASSWORD`, ou configure `DATABASE_URL`. Pour une base distante qui exige TLS, définis `DATABASE_SSL=true` (la vérification du certificat reste activée par défaut).

Puis ouvre <http://localhost:3847> dans ton navigateur. Le port peut être remplacé en définissant la variable d’environnement `PORT`.
Par défaut, le serveur écoute uniquement sur `127.0.0.1`. Pour choisir une autre interface, définissez `HOST`.
N’ouvrez pas directement `public/index.html` avec Live Server : cette application a besoin des routes API fournies par le serveur Node.
L’inscription est ouverte en local. Les comptes et leurs mots de passe hachés sont stockés dans la table PostgreSQL `app_users`. Les tables nécessaires sont créées au démarrage. Si `data/users.json` existe, ses comptes sont importés une fois puis le fichier est archivé sous `data/users.json.migrated`. Une session est conservée dans un cookie HTTP-only; elle expire après sept jours et prend fin au redémarrage du serveur.

### Installer les outils requis

Installez Python 3 et FFmpeg avec le gestionnaire de paquets de votre système, puis installez ou mettez à jour `yt-dlp` :

```bash
# Windows
py -3 -m pip install -U yt-dlp

# macOS / Linux
python3 -m pip install -U yt-dlp
```

Si nécessaire, indiquez le chemin de l’interpréteur Python avec `GRAB_PYTHON`, ou celui du dossier contenant FFmpeg avec `FFMPEG_DIR`.

## Docker

Le dépôt contient un `Dockerfile` qui installe Node.js, Python, FFmpeg et la branche nightly de `yt-dlp`. Le projet yt-dlp recommande cette branche pour suivre les changements fréquents des plateformes : [canaux de publication yt-dlp](https://github.com/yt-dlp/yt-dlp#update).

Copie `.env.example` vers `.env`, remplace les deux valeurs par des secrets uniques, puis démarre l’application et PostgreSQL :

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

L’application sera disponible sur <http://localhost:3847>. PostgreSQL est exposé uniquement sur la machine locale au port `5433` (le port `5432` du conteneur reste interne au réseau Docker); ses données persistent dans le volume Docker `postgres-data`. Le volume historique `media-downloader-data` est monté pour importer les anciens comptes JSON et garder leur copie d’archive.

`APP_PASSWORD` sert de code d’invitation pour créer un compte. Il est obligatoire dès que `HOST` n’est pas une interface locale. Pour un accès depuis un réseau, place l’application derrière un proxy HTTPS. Le serveur limite à deux extractions et quatre flux directs simultanés. Le volume PostgreSQL conserve les comptes entre les redémarrages des conteneurs.

## Déploiement sur un hébergeur

Déploie le `Dockerfile` comme service web conteneurisé avec un processus Node persistant et une base PostgreSQL persistante. Configure `HOST=0.0.0.0`, le `PORT` fourni par l’hébergeur, `DATABASE_URL` (ou les variables `PG*`) et un `APP_PASSWORD` fort. L’endpoint `GET /health` vérifie que l’application et PostgreSQL répondent. Garde une seule instance pour l’instant : les sessions, la progression et les fichiers temporaires des téléchargements sont conservés en mémoire ou sur le disque local du processus.

## Cookies YouTube sur Railway

Si YouTube affiche « Sign in to confirm you're not a bot », il bloque la requête du serveur ou exige une session connectée. Les réglages yt-dlp seuls ne peuvent pas garantir l’accès. Le serveur sait utiliser un fichier de cookies, mais Railway ne peut pas lire ceux de ton navigateur automatiquement.

Pour configurer l’instance :

1. Utilise de préférence un compte Google secondaire dédié à ce service. Toute personne autorisée à lancer une extraction peut provoquer des requêtes YouTube avec la session fournie au serveur.
2. Connecte ce compte à YouTube et exporte ses cookies au format Netscape `cookies.txt`. Pour les recommandations yt-dlp sur l’export et les cookies qui expirent ou tournent, consulte [Exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).
3. Sur Windows, encode le fichier en Base64 et copie le résultat dans le presse-papiers :

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\chemin\cookies.txt")) | Set-Clipboard
   ```

4. Dans Railway, ouvre le service web **Mediadownloader** → **Variables** et ajoute `YTDLP_COOKIES_B64`. Colle la valeur, enregistre, puis déploie les changements. Utilise une variable secrète/scellée si l’option est disponible. Railway injecte ses variables dans l’environnement du service au déploiement : [documentation Railway sur les variables](https://docs.railway.com/variables).
5. Supprime le fichier exporté lorsque tu n’en as plus besoin et efface le presse-papiers. Si YouTube recommence à bloquer, renouvelle les cookies et remplace la variable.

Les cookies sont des identifiants de session : quiconque les obtient peut agir comme le compte connecté. Ne les envoie jamais dans un chat, ne les ajoute pas au dépôt Git et ne les affiche pas dans un journal. Base64 n’est pas du chiffrement. L’application accepte le contenu encodé dans `YTDLP_COOKIES_B64`, ou un chemin local `YTDLP_COOKIES` ; en dernier recours elle cherche `cookies.txt` à côté de `server.js`.

## Utilisation responsable

Utilisez cette application uniquement pour télécharger du contenu que vous êtes autorisé à récupérer. Respectez les droits d’auteur, les conditions d’utilisation des sites concernés et la législation applicable. Ne partagez pas publiquement un déploiement sans avoir évalué les risques liés à son accès et à son utilisation.
