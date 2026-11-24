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

- Node.js 20 ou version ultérieure.
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

Le dépôt contient un `Dockerfile` qui installe Node.js, Python, FFmpeg et `yt-dlp` :

Copie `.env.example` vers `.env`, remplace les deux valeurs par des secrets uniques, puis démarre l’application et PostgreSQL :

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

L’application sera disponible sur <http://localhost:3847>. PostgreSQL est exposé uniquement sur la machine locale au port `5433` (le port `5432` du conteneur reste interne au réseau Docker); ses données persistent dans le volume Docker `postgres-data`. Le volume historique `media-downloader-data` est monté pour importer les anciens comptes JSON et garder leur copie d’archive.

`APP_PASSWORD` sert de code d’invitation pour créer un compte. Il est obligatoire dès que `HOST` n’est pas une interface locale. Pour un accès depuis un réseau, place l’application derrière un proxy HTTPS. Le serveur limite à deux extractions et quatre flux directs simultanés. Le volume PostgreSQL conserve les comptes entre les redémarrages des conteneurs.

## Déploiement sur un hébergeur

Déploie le `Dockerfile` comme service web conteneurisé avec un processus Node persistant et une base PostgreSQL persistante. Configure `HOST=0.0.0.0`, le `PORT` fourni par l’hébergeur, `DATABASE_URL` (ou les variables `PG*`) et un `APP_PASSWORD` fort. L’endpoint `GET /health` vérifie que l’application et PostgreSQL répondent. Garde une seule instance pour l’instant : les sessions, la progression et les fichiers temporaires des téléchargements sont conservés en mémoire ou sur le disque local du processus.

## Cookies YouTube par compte

Si YouTube affiche « Sign in to confirm you're not a bot », chaque utilisateur peut choisir d’ajouter ses propres cookies depuis **Mon profil**. Le consentement est séparé et facultatif ; le reste de l’application reste accessible sans cookies. Le serveur filtre le fichier pour ne conserver que les domaines `youtube.com` et sous-domaines. Les cookies d’un compte ne sont utilisés que pour les extractions YouTube démarrées avec ce compte.

Avant que l’envoi soit disponible, configure une clé de chiffrement dans Railway :

1. Génère une clé aléatoire de 32 octets et copie-la dans le presse-papiers :

   ```powershell
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
   ```

2. Dans Railway, ouvre le service web **Mediadownloader** → **Variables**, ajoute `YOUTUBE_COOKIES_ENCRYPTION_KEY`, colle la clé, enregistre et déploie. Utilise une variable secrète/scellée si l’option est disponible. Railway injecte ses variables au démarrage du service : [documentation Railway sur les variables](https://docs.railway.com/variables).
3. Garde la clé dans Railway. Ne la publie pas et ne la change pas sans planifier la réimportation des cookies : les anciennes valeurs chiffrées ne pourront plus être déchiffrées avec une autre clé.
4. Chaque utilisateur peut exporter ses cookies YouTube au format Netscape `cookies.txt`, aller dans **Mon profil**, lire les informations, cocher son consentement et envoyer le fichier. Pour les recommandations yt-dlp sur l’export et les cookies qui expirent ou tournent, consulte [Exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).

Les fichiers enregistrés sont chiffrés en AES-256-GCM dans PostgreSQL. Le serveur les déchiffre brièvement dans un fichier temporaire pendant l’extraction du même utilisateur, puis le supprime. Le responsable du serveur peut techniquement y accéder pendant ce traitement ; ce n’est pas un chiffrement de bout en bout. Chaque utilisateur peut retirer son consentement et supprimer ses cookies depuis son profil. Ces cookies sont des identifiants de session : ne les envoie jamais dans un chat et ne les ajoute pas au dépôt Git. YouTube peut les invalider, et la présence de cookies ne garantit pas que YouTube accepte les requêtes Railway.

## Utilisation responsable

Utilisez cette application uniquement pour télécharger du contenu que vous êtes autorisé à récupérer. Respectez les droits d’auteur, les conditions d’utilisation des sites concernés et la législation applicable. Ne partagez pas publiquement un déploiement sans avoir évalué les risques liés à son accès et à son utilisation.
