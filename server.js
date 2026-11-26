const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;
const net = require("net");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
require("dotenv").config();
const { Pool } = require("pg");

const PORT = process.env.PORT || 3847;
const HOST = process.env.HOST || "127.0.0.1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const LEGACY_USERS_FILE = path.join(__dirname, "data", "users.json");
const SESSION_COOKIE = "media_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_COLUMNS = `id, username, display_name AS "displayName", password_hash AS "passwordHash", created_at AS "createdAt"`;
const MAX_BYTES = 500 * 1024 * 1024; // 500 Mo
const MAX_ACTIVE_JOBS = 2;
const MAX_ACTIVE_STREAMS = 4;
const ACCOUNT_API_PATHS = new Set([
  "/api/auth/config",
  "/api/auth/me",
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/profile",
  "/api/profile/password",
]);
const PUBLIC_DIR = path.join(__dirname, "public");
const TMP_DIR = path.join(os.tmpdir(), "grab-media");
const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5433),
      database: process.env.PGDATABASE || "media_downloader",
      user: process.env.PGUSER || "media_downloader",
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    }),
  ...(process.env.DATABASE_SSL === "true"
    ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } }
    : {}),
  connectionTimeoutMillis: 5000,
});
const sessions = new Map();
const authAttempts = new Map();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

pool.on("error", (err) => {
  console.error("Erreur PostgreSQL sur une connexion inactive :", err.message);
});

function resolvePythonPath() {
  if (process.env.GRAB_PYTHON) return process.env.GRAB_PYTHON;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const installRoot = path.join(process.env.LOCALAPPDATA, "Programs", "Python");
    try {
      const installs = fs.readdirSync(installRoot)
        .filter((name) => /^Python\d+$/i.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const install of installs) {
        const executable = path.join(installRoot, install, "python.exe");
        if (fs.existsSync(executable)) return executable;
      }
    } catch {}
    return "py";
  }
  return "python3";
}

const PYTHON = resolvePythonPath();
const LOCAL_FFMPEG_DIR = path.join(__dirname, "tools", "ffmpeg-9.0.1-essentials_build", "bin");
const FFMPEG_DIR = process.env.FFMPEG_DIR || (fs.existsSync(LOCAL_FFMPEG_DIR) ? LOCAL_FFMPEG_DIR : null);

const DIRECT_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".ogg",
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
]);

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/x-matroska": ".mkv",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
};

const PLATFORM_LABELS = [
  { match: /youtube\.com|youtu\.be/i, label: "YouTube" },
  { match: /tiktok\.com/i, label: "TikTok" },
  { match: /instagram\.com/i, label: "Instagram" },
  { match: /pinterest\.|pin\.it/i, label: "Pinterest" },
  { match: /twitter\.com|\bx\.com\b/i, label: "X" },
  { match: /facebook\.com|fb\.watch/i, label: "Facebook" },
  { match: /vimeo\.com/i, label: "Vimeo" },
  { match: /dailymotion\.com/i, label: "Dailymotion" },
  { match: /reddit\.com/i, label: "Reddit" },
  { match: /soundcloud\.com/i, label: "SoundCloud" },
  { match: /twitch\.tv/i, label: "Twitch" },
];

fs.mkdirSync(TMP_DIR, { recursive: true });

function cleanTmpDir() {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const fp = path.join(TMP_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 3600000) {
          fs.unlinkSync(fp);
        }
      } catch {}
    }
  } catch {}
}
cleanTmpDir();
setInterval(cleanTmpDir, 1800000);

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
      display_name VARCHAR(48) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 48),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await migrateLegacyUsers();
}

function archiveLegacyUsers() {
  if (!fs.existsSync(LEGACY_USERS_FILE)) return;
  let archivePath = `${LEGACY_USERS_FILE}.migrated`;
  if (fs.existsSync(archivePath)) archivePath = `${archivePath}.${Date.now()}`;
  try {
    fs.renameSync(LEGACY_USERS_FILE, archivePath);
  } catch (err) {
    console.warn("Les comptes ont été importés, mais le fichier JSON historique n’a pas pu être archivé :", err.message);
  }
}

async function migrateLegacyUsers() {
  if (!fs.existsSync(LEGACY_USERS_FILE)) return;

  const migrationName = "import-users-json-v1";
  const alreadyMigrated = await pool.query("SELECT 1 FROM app_migrations WHERE name = $1", [migrationName]);
  if (alreadyMigrated.rowCount) {
    archiveLegacyUsers();
    return;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, "utf8"));
  } catch (err) {
    console.warn("Le fichier JSON historique des comptes est illisible; il reste en place et n’a pas été importé :", err.message);
    return;
  }
  if (!store || !Array.isArray(store.users)) {
    console.warn("Le fichier JSON historique des comptes a un format invalide; il reste en place et n’a pas été importé.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const user of store.users) {
      if (
        !user ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id || "") ||
        !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(user.username || "") ||
        typeof user.displayName !== "string" || !user.displayName.trim() || user.displayName.length > 48 ||
        !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(user.passwordHash || "") ||
        !Number.isFinite(Date.parse(user.createdAt || ""))
      ) continue;

      await client.query(
        `INSERT INTO app_users (id, username, display_name, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING`,
        [user.id, user.username, user.displayName, user.passwordHash, user.createdAt],
      );
    }
    await client.query("INSERT INTO app_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [migrationName]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  archiveLegacyUsers();
  console.info("Les anciens comptes locaux ont été importés dans PostgreSQL.");
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
  };
}

function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptPassword(password, salt);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password, encodedHash) {
  const [saltHex, hashHex] = String(encodedHash || "").split(":");
  if (!/^[a-f0-9]{32}$/i.test(saltHex || "") || !/^[a-f0-9]{128}$/i.test(hashHex || "")) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptPassword(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const DUMMY_PASSWORD_HASH = (() => {
  const salt = Buffer.alloc(16, 0x5a);
  return `${salt.toString("hex")}:${crypto.scryptSync("not-a-real-password", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
})();

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

function readSessionToken(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try { return decodeURIComponent(cookie.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
}

async function readSession(req) {
  const token = readSessionToken(req);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const result = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users WHERE id = $1`, [session.userId]);
  const user = userFromRow(result.rows[0]);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return { token, session, user };
}

function setSessionCookie(req, res, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
  const value = token ? encodeURIComponent(token) : "";
  const cookie = `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", cookie);
}

function allowAuthAttempt(req, action) {
  const key = `${req.socket.remoteAddress || "unknown"}:${action}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = authAttempts.get(key);
  if (!entry || now - entry.startedAt >= windowMs) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count += 1;
  return true;
}

async function readJsonBody(req) {
  if (!(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    throw new HttpError(400, "Le corps de la requête doit être au format JSON.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, "La requête est trop volumineuse.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Corps JSON invalide.");
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(req, res, token);
}

async function handleAccountApi(req, res, parsedReq) {
  const pathname = parsedReq.pathname;

  if (pathname === "/api/auth/config" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, inviteRequired: Boolean(APP_PASSWORD) });
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const auth = await readSession(req);
    if (!auth) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, { ok: true, user: publicUser(auth.user) });
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    if (!allowAuthAttempt(req, "register")) {
      return sendJson(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    }
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim();
    const password = String(body.password || "");

    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      return sendJson(res, 400, { error: "Le nom d’utilisateur doit contenir 3 à 32 lettres, chiffres, points, tirets ou tirets bas." });
    }
    if (!displayName || displayName.length > 48) {
      return sendJson(res, 400, { error: "Le nom affiché doit contenir entre 1 et 48 caractères." });
    }
    if (password.length < 10 || password.length > 128) {
      return sendJson(res, 400, { error: "Le mot de passe doit contenir entre 10 et 128 caractères." });
    }
    if (APP_PASSWORD && !constantTimeEqual(body.inviteCode, APP_PASSWORD)) {
      return sendJson(res, 403, { error: "Code d’invitation incorrect." });
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    let result;
    try {
      result = await pool.query(
        `INSERT INTO app_users (id, username, display_name, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
        [id, username, displayName, passwordHash],
      );
    } catch (err) {
      if (err.code === "23505") return sendJson(res, 409, { error: "Ce nom d’utilisateur est déjà utilisé." });
      throw err;
    }
    const user = userFromRow(result.rows[0]);
    createSession(req, res, user);
    authAttempts.delete(`${req.socket.remoteAddress || "unknown"}:register`);
    return sendJson(res, 201, { ok: true, user: publicUser(user) });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    if (!allowAuthAttempt(req, "login")) {
      return sendJson(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    }
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (password.length > 128) {
      return sendJson(res, 401, { error: "Nom d’utilisateur ou mot de passe incorrect." });
    }
    const result = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users WHERE username = $1`, [username]);
    const user = userFromRow(result.rows[0]);
    const passwordMatches = await verifyPassword(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      return sendJson(res, 401, { error: "Nom d’utilisateur ou mot de passe incorrect." });
    }

    authAttempts.delete(`${req.socket.remoteAddress || "unknown"}:login`);
    createSession(req, res, user);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const token = readSessionToken(req);
    if (token) sessions.delete(token);
    setSessionCookie(req, res, "", 0);
    return sendJson(res, 200, { ok: true });
  }

  const auth = await readSession(req);
  if (pathname === "/api/profile" && req.method === "GET") {
    if (!auth) return sendJson(res, 401, { error: "Connexion requise." });
    return sendJson(res, 200, { ok: true, user: publicUser(auth.user) });
  }

  if (pathname === "/api/profile" && req.method === "POST") {
    if (!auth) return sendJson(res, 401, { error: "Connexion requise." });
    const body = await readJsonBody(req);
    const displayName = String(body.displayName || "").trim();
    if (!displayName || displayName.length > 48) {
      return sendJson(res, 400, { error: "Le nom affiché doit contenir entre 1 et 48 caractères." });
    }
    const result = await pool.query(
      `UPDATE app_users SET display_name = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [auth.user.id, displayName],
    );
    const updated = userFromRow(result.rows[0]);
    if (!updated) return sendJson(res, 401, { error: "Compte introuvable." });
    return sendJson(res, 200, { ok: true, user: publicUser(updated) });
  }

  if (pathname === "/api/profile/password" && req.method === "POST") {
    if (!auth) return sendJson(res, 401, { error: "Connexion requise." });
    const body = await readJsonBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (currentPassword.length > 128) {
      return sendJson(res, 401, { error: "Mot de passe actuel incorrect." });
    }
    if (newPassword.length < 10 || newPassword.length > 128) {
      return sendJson(res, 400, { error: "Le nouveau mot de passe doit contenir entre 10 et 128 caractères." });
    }
    const current = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users WHERE id = $1`, [auth.user.id]);
    const existingUser = userFromRow(current.rows[0]);
    if (!existingUser || !(await verifyPassword(currentPassword, existingUser.passwordHash))) {
      return sendJson(res, 401, { error: "Mot de passe actuel incorrect." });
    }
    const passwordHash = await hashPassword(newPassword);
    const updatedResult = await pool.query(
      `UPDATE app_users SET password_hash = $3
       WHERE id = $1 AND password_hash = $2 RETURNING ${USER_COLUMNS}`,
      [existingUser.id, existingUser.passwordHash, passwordHash],
    );
    const updated = userFromRow(updatedResult.rows[0]);
    if (!updated) return sendJson(res, 409, { error: "Le mot de passe a changé entre-temps. Recharge la page puis réessaie." });
    for (const [token, session] of sessions) {
      if (session.userId === updated.id) sessions.delete(token);
    }
    createSession(req, res, updated);
    return sendJson(res, 200, { ok: true, message: "Mot de passe modifié." });
  }

  return false;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const normalized = String(ip).toLowerCase().replace(/^::ffff:/, "");
  const family = net.isIP(normalized);

  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    const value = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
    const ranges = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];

    return ranges.some(([network, prefix]) => {
      const base = network.split(".").map(Number);
      const networkValue = (((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0);
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      return (value & mask) === (networkValue & mask);
    });
  }

  if (family === 6) {
    // Mapped IPv4 addresses are rejected to avoid bypasses through alternate IPv6 forms.
    if (String(ip).toLowerCase().startsWith("::ffff:")) return true;
    const hextets = normalized.split(":");
    const firstHextet = Number.parseInt(hextets[0] || "0", 16);
    const secondHextet = Number.parseInt(hextets[1] || "0", 16);
    const isGlobalUnicast = firstHextet >= 0x2000 && firstHextet <= 0x3fff;
    const isSpecialPurpose =
      (firstHextet === 0x2001 && (secondHextet === 0 || secondHextet === 0x0db8)) ||
      firstHextet === 0x2002;
    return !isGlobalUnicast || isSpecialPurpose;
  }

  return true;
}

function platformLabel(raw) {
  for (const item of PLATFORM_LABELS) {
    if (item.match.test(raw)) return item.label;
  }
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "site";
  }
}

function looksLikeDirectMedia(raw) {
  try {
    const ext = path.extname(new URL(raw).pathname).toLowerCase();
    return DIRECT_EXTS.has(ext);
  } catch {
    return false;
  }
}

async function resolveSafeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL invalide.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Seuls http et https sont autorisés.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Les identifiants intégrés à l’URL sont interdits.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const dnsHostname = hostname.replace(/\.$/, "");
  if (dnsHostname === "localhost" || dnsHostname.endsWith(".localhost") || dnsHostname.endsWith(".local")) {
    throw new Error("Hôtes locaux interdits.");
  }

  let addresses;
  try {
    const family = net.isIP(dnsHostname);
    addresses = family
      ? [{ address: dnsHostname, family }]
      : await dns.lookup(dnsHostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Impossible de résoudre l'hôte.");
  }

  if (!addresses.length) throw new Error("Impossible de résoudre l'hôte.");
  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new Error("Adresse privée / locale interdite.");
    }
  }

  return { parsed, addresses };
}

async function assertSafeUrl(raw) {
  const { parsed } = await resolveSafeUrl(raw);
  return parsed;
}

function guessFilename(targetUrl, contentType, contentDisposition) {
  if (contentDisposition) {
    const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);
    if (match) {
      try {
        return decodeURIComponent(match[1].replace(/"/g, "").trim());
      } catch {
        return match[1].replace(/"/g, "").trim();
      }
    }
  }

  const base = path.basename(targetUrl.pathname) || "media";
  const clean = base.split("?")[0];
  if (path.extname(clean)) return clean;

  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  return clean + (MIME_EXT[mime] || ".bin");
}

function classify(contentType) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

function sanitizeFilename(name) {
  let clean = String(name || "media")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\.\s]+$/, "");

  if (!clean) clean = "media";

  const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reservedNames.test(clean)) {
    clean = clean + "_file";
  }

  return clean.slice(0, 120);
}

function buildContentDisposition(filename) {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\r\n\\]/g, "");
  const encodedName = encodeURIComponent(filename)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function mediaFromYtInfo(info) {
  const ext = String(info.ext || "mp4").toLowerCase();
  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
  const audioExts = new Set(["mp3", "m4a", "opus", "ogg", "wav", "flac", "aac"]);

  if (imageExts.has(ext)) {
    const mimeExt = ext === "jpg" ? "jpeg" : ext;
    return { type: "image", mime: `image/${mimeExt}`, defaultExt: `.${ext === "jpeg" ? "jpg" : ext}` };
  }

  const vcodec = info.vcodec && info.vcodec !== "none";
  const acodec = info.acodec && info.acodec !== "none";

  if (!vcodec && acodec) {
    const mime =
      ext === "mp3"
        ? "audio/mpeg"
        : ext === "m4a"
          ? "audio/mp4"
          : `audio/${ext}`;
    return { type: "audio", mime, defaultExt: `.${ext}` };
  }

  if (audioExts.has(ext) && !vcodec) {
    return { type: "audio", mime: `audio/${ext === "mp3" ? "mpeg" : ext}`, defaultExt: `.${ext}` };
  }

  if (!vcodec && !acodec && (info.thumbnail || info.thumbnails)) {
    return { type: "image", mime: "image/jpeg", defaultExt: ".jpg" };
  }

  return {
    type: "video",
    mime: ext === "webm" ? "video/webm" : "video/mp4",
    defaultExt: ext === "webm" ? ".webm" : ".mp4",
  };
}

const activeJobs = new Map();
let activeRemoteStreams = 0;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [key, attempt] of authAttempts.entries()) {
    if (now - attempt.startedAt > 15 * 60 * 1000) authAttempts.delete(key);
  }
  for (const [id, job] of activeJobs.entries()) {
    if (now - job.createdAt > 15 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlink(job.filePath, () => {});
      }
      activeJobs.delete(id);
    }
  }
}, 60000);

function normalizeMediaUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
      if (u.pathname === "/watch" && u.searchParams.has("v")) {
        const videoId = u.searchParams.get("v");
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
      if (u.hostname.includes("youtu.be")) {
        const videoId = u.pathname.replace(/^\//, "");
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    return urlStr;
  } catch {
    return urlStr;
  }
}

function runYtDlp(args, onProgress, maxOutput) {
  const commonArgs = [
    "--js-runtimes",
    "node",
    ...(FFMPEG_DIR ? ["--ffmpeg-location", FFMPEG_DIR] : []),
    ...args,
  ];

  const tryExec = (cmd, cmdArgs) => {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, cmdArgs, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let sizeLimitError = null;
      let sizeMonitor = null;

      const stopSizeMonitor = () => {
        if (sizeMonitor) clearInterval(sizeMonitor);
        sizeMonitor = null;
      };

      const inspectOutputSize = () => {
        if (!maxOutput || sizeLimitError) return;
        try {
          const total = fs
            .readdirSync(TMP_DIR)
            .filter((file) => file.startsWith(maxOutput.prefix))
            .reduce((sum, file) => {
              try {
                return sum + fs.statSync(path.join(TMP_DIR, file)).size;
              } catch {
                return sum;
              }
            }, 0);

          if (total > maxOutput.maxBytes) {
            sizeLimitError = new Error("Fichier trop volumineux (max 500 Mo).");
            sizeLimitError.code = "MAX_OUTPUT_SIZE";
            child.kill();
            stopSizeMonitor();
          }
        } catch {}
      };

      if (maxOutput) sizeMonitor = setInterval(inspectOutputSize, 100);

      const handleLine = (line) => {
        if (!onProgress) return;
        const m = /\[download\]\s+([\d\.]+)%\s+of\s+([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i.exec(line);
        if (m) {
          onProgress({
            percent: parseFloat(m[1]),
            totalSize: m[2] || "",
            speed: m[3] || "",
            eta: m[4] || "",
          });
        }
      };

      child.stdout.on("data", (chunk) => {
        const str = chunk.toString();
        stdout += str;
        if (onProgress) {
          const lines = str.split(/[\r\n]+/);
          for (const l of lines) handleLine(l);
        }
      });
      child.stderr.on("data", (chunk) => {
        const str = chunk.toString();
        stderr += str;
        if (onProgress) {
          const lines = str.split(/[\r\n]+/);
          for (const l of lines) handleLine(l);
        }
      });

      child.on("error", (err) => {
        stopSizeMonitor();
        reject(sizeLimitError || err);
      });
      child.on("close", (code) => {
        stopSizeMonitor();
        if (sizeLimitError) {
          reject(sizeLimitError);
          return;
        }
        if (code === 0) resolve({ stdout, stderr });
        else {
          const lines = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean);
          const geoHintIndex = lines.findIndex((line) => /You might want to use a VPN or a proxy server/i.test(line));
          const errorLines = geoHintIndex >= 0
            ? lines.slice(Math.max(0, geoHintIndex - 2), geoHintIndex + 1)
            : lines.slice(-1);
          const msg = errorLines
            .map((line) => line.replace(/^ERROR:\s*/i, "").trim())
            .filter(Boolean)
            .join(" ") || "Site non supporté ou média inaccessible.";
          reject(new Error(msg));
        }
      });
    });
  };

  const canFallback = (err) => err.code !== "MAX_OUTPUT_SIZE";
  const pythonBase = path.basename(PYTHON).replace(/\.exe$/i, "").toLowerCase();
  const primaryPythonArgs = pythonBase === "py" ? ["-3", "-m", "yt_dlp"] : ["-m", "yt_dlp"];
  const fallbackPython = async () => {
    const candidates = process.platform === "win32"
      ? [
          ["py", ["-3", "-m", "yt_dlp", ...commonArgs]],
          ["python", ["-m", "yt_dlp", ...commonArgs]],
        ]
      : [["python3", ["-m", "yt_dlp", ...commonArgs]]];
    let lastError;
    for (const [command, commandArgs] of candidates) {
      try {
        return await tryExec(command, commandArgs);
      } catch (err) {
        if (!canFallback(err)) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error("Python 3 est introuvable.");
  };

  return tryExec(PYTHON, [...primaryPythonArgs, ...commonArgs])
    .catch((err) => canFallback(err) ? tryExec("yt-dlp", commonArgs) : Promise.reject(err))
    .catch((err) => canFallback(err) ? fallbackPython() : Promise.reject(err))
    .catch((err) => {
      if (err.code === "MAX_OUTPUT_SIZE") throw err;
      if (/Microsoft Store|Python was not found|Python est introuvable|No module named.*yt_dlp|yt_dlp.*not found|ENOENT|not recognized as an internal/i.test(err.message || "")) {
        throw new Error("Python 3 et yt-dlp sont requis. Installe yt-dlp avec `py -3 -m pip install -U yt-dlp`, puis relance le téléchargement.");
      }
      throw err;
    });
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return null;
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function buildDownloadChoices(info, mediaType) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heightSet = new Set();
  let hasVideo = mediaType === "video";
  let hasAudioTrack = mediaType === "audio";

  for (const f of formats) {
    const vcodec = f.vcodec && f.vcodec !== "none";
    const acodec = f.acodec && f.acodec !== "none";
    if (vcodec) {
      hasVideo = true;
      if (f.height) heightSet.add(Number(f.height));
    }
    if (acodec) hasAudioTrack = true;
  }

  if (info.height) heightSet.add(Number(info.height));

  const resolutions = [...heightSet]
    .filter((h) => h > 0 && !Number.isNaN(h))
    .sort((a, b) => b - a)
    .map((height) => ({
      height,
      label: `${height}p`,
    }));

  // Toujours proposer "meilleure" en tête
  const resolutionOptions = [{ height: 0, label: "Meilleure disponible" }, ...resolutions];

  const choices = {
    canVideo: hasVideo && mediaType !== "image",
    canAudio: hasAudioTrack && mediaType !== "image",
    resolutions: resolutionOptions,
    videoContainers: ["mp4", "webm", "mkv"],
    audioFormats: ["mp3", "m4a", "opus", "wav"],
    defaults: {
      mode: hasVideo && mediaType !== "audio" ? "video" : "audio",
      height: 0,
      container: "mp4",
      audioFormat: "mp3",
    },
  };

  return choices;
}

function parseDownloadOptions(searchParams) {
  const mode = searchParams.get("mode") === "audio" ? "audio" : "video";
  let height = Number(searchParams.get("height") || 0);
  if (!Number.isFinite(height) || height < 0) height = 0;
  if (height > 4320) height = 4320;

  const containerRaw = (searchParams.get("container") || "mp4").toLowerCase();
  const container = ["mp4", "webm", "mkv"].includes(containerRaw) ? containerRaw : "mp4";

  const audioRaw = (searchParams.get("audioFormat") || "mp3").toLowerCase();
  const audioFormat = ["mp3", "m4a", "opus", "wav", "flac"].includes(audioRaw)
    ? audioRaw
    : "mp3";

  return { mode, height, container, audioFormat };
}

function buildYtFormatSelector(options) {
  const { mode, height, container } = options;

  if (mode === "audio") {
    return "ba/b";
  }

  const heightFilter = height > 0 ? `[height<=${height}]` : "";
  if (container === "mp4") {
    return [
      `bv*${heightFilter}[ext=mp4]+ba[ext=m4a]`,
      `bv*${heightFilter}+ba`,
      `b${heightFilter}[ext=mp4]`,
      `b${heightFilter}`,
      "bv*+ba/b",
    ].join("/");
  }

  if (container === "webm") {
    return [
      `bv*${heightFilter}[ext=webm]+ba`,
      `bv*${heightFilter}+ba`,
      `b${heightFilter}`,
      "bv*+ba/b",
    ].join("/");
  }

  return [`bv*${heightFilter}+ba`, `b${heightFilter}`, "bv*+ba/b"].join("/");
}

// Resolve cookies file path once at startup
let COOKIES_FILE_PATH = null;
let TEMP_COOKIES_PATH = null;

(function initCookies() {
  // Priority 1: base64-encoded cookies content in env var (ideal for Render/cloud)
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64").toString("utf-8");
      const tmpCookies = path.join(
        os.tmpdir(),
        `ytdlp_cookies_${process.pid}_${crypto.randomBytes(8).toString("hex")}.txt`
      );
      fs.writeFileSync(tmpCookies, decoded, { encoding: "utf-8", mode: 0o600 });
      COOKIES_FILE_PATH = tmpCookies;
      TEMP_COOKIES_PATH = tmpCookies;
      console.log("[cookies] Loaded from YTDLP_COOKIES_B64 →", tmpCookies);
    } catch (e) {
      console.warn("[cookies] Failed to decode YTDLP_COOKIES_B64:", e.message);
    }
  }
  // Priority 2: path to cookies file
  if (!COOKIES_FILE_PATH && process.env.YTDLP_COOKIES) {
    if (fs.existsSync(process.env.YTDLP_COOKIES)) {
      COOKIES_FILE_PATH = process.env.YTDLP_COOKIES;
      console.log("[cookies] Loaded from YTDLP_COOKIES env path →", COOKIES_FILE_PATH);
    } else {
      console.warn("[cookies] YTDLP_COOKIES path not found:", process.env.YTDLP_COOKIES);
    }
  }
  // Priority 3: cookies.txt beside server.js
  if (!COOKIES_FILE_PATH && fs.existsSync(path.join(__dirname, "cookies.txt"))) {
    COOKIES_FILE_PATH = path.join(__dirname, "cookies.txt");
    console.log("[cookies] Loaded from local cookies.txt →", COOKIES_FILE_PATH);
  }
  if (!COOKIES_FILE_PATH) {
    console.warn("[cookies] No cookies found — YouTube may block server requests.");
  }
})();

process.once("exit", () => {
  if (!TEMP_COOKIES_PATH) return;
  try {
    fs.unlinkSync(TEMP_COOKIES_PATH);
  } catch {}
});

function getCommonYtDlpArgs(target) {
  const args = ["--no-playlist", "--no-warnings", "-4"];
  let isYoutube = false;
  try {
    const hostname = new URL(target).hostname.toLowerCase();
    isYoutube = hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch {}

  // Let yt-dlp select its maintained YouTube clients. Forced legacy mobile
  // clients can return no player response and do not support account cookies.
  if (isYoutube && COOKIES_FILE_PATH) {
    args.push("--cookies", COOKIES_FILE_PATH);
  }

  return args;
}

async function inspectViaExtractor(target) {
  const cleanTarget = normalizeMediaUrl(target);
  await assertSafeUrl(cleanTarget);

  const { stdout } = await runYtDlp([
    ...getCommonYtDlpArgs(cleanTarget),
    "--dump-single-json",
    "--skip-download",
    cleanTarget,
  ]);

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("Impossible de lire les infos du média.");
  }

  if (info._type === "playlist" && Array.isArray(info.entries) && info.entries[0]) {
    info = info.entries.find((e) => e && !e._type) || info.entries[0];
  }

  const media = mediaFromYtInfo(info);
  const title = info.title || info.fulltitle || platformLabel(target);
  const filename = `${sanitizeFilename(title)}${media.defaultExt}`;
  const thumb =
    info.thumbnail ||
    (Array.isArray(info.thumbnails) && info.thumbnails.length
      ? info.thumbnails[info.thumbnails.length - 1].url
      : null);

  const choices = buildDownloadChoices(info, media.type);

  return {
    ok: true,
    source: "extractor",
    platform: platformLabel(target),
    extractor: info.extractor_key || info.extractor || null,
    type: media.type,
    mime: media.mime,
    size: info.filesize || info.filesize_approx || null,
    filename,
    title,
    duration: formatDuration(info.duration),
    channel: info.channel || info.uploader || info.creator || null,
    previewUrl: thumb,
    choices,
    downloadUrl: `/api/extract/download?url=${encodeURIComponent(target)}`,
  };
}

async function downloadViaExtractorToTempProgress(jobId, target, options, suggestedTitle) {
  const cleanTarget = normalizeMediaUrl(target);
  await assertSafeUrl(cleanTarget);
  const id = crypto.randomBytes(8).toString("hex");
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const opts = options || { mode: "video", height: 0, container: "mp4", audioFormat: "mp3" };

  const args = [
    ...getCommonYtDlpArgs(cleanTarget),
    "--max-filesize",
    String(MAX_BYTES),
    "-o",
    outTemplate,
  ];

  if (opts.mode === "audio") {
    args.push(
      "-f",
      buildYtFormatSelector(opts),
      "-x",
      "--audio-format",
      opts.audioFormat,
      "--audio-quality",
      "0"
    );
  } else {
    args.push(
      "-f",
      buildYtFormatSelector(opts),
      "--merge-output-format",
      opts.container
    );
  }

  args.push(cleanTarget);

  const job = activeJobs.get(jobId);

  try {
    await runYtDlp(args, (prog) => {
      if (job) {
        job.percent = prog.percent;
        job.totalSize = prog.totalSize;
        job.speed = prog.speed;
        job.eta = prog.eta;
      }
    }, { prefix: id + ".", maxBytes: MAX_BYTES });
  } catch (err) {
    try {
      const partialFiles = fs.readdirSync(TMP_DIR).filter((file) => file.startsWith(id + "."));
      for (const file of partialFiles) fs.unlinkSync(path.join(TMP_DIR, file));
    } catch {}
    throw err;
  }

  const tempExtensions = [".part", ".ytdl", ".temp", ".tmp", ".unc"];
  const files = fs.readdirSync(TMP_DIR).filter((f) => {
    if (!f.startsWith(id + ".")) return false;
    const lower = f.toLowerCase();
    return !tempExtensions.some((ext) => lower.endsWith(ext));
  });

  if (!files.length) {
    throw new Error("Téléchargement terminé sans fichier.");
  }

  const filePath = path.join(TMP_DIR, files[0]);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) {
    fs.unlinkSync(filePath);
    throw new Error("Fichier trop volumineux (max 500 Mo).");
  }

  const ext = path.extname(filePath) || (opts.mode === "audio" ? `.${opts.audioFormat}` : `.${opts.container}`);
  const filename = sanitizeFilename(suggestedTitle || "media") + ext;

  if (job) {
    job.status = "ready";
    job.percent = 100;
    job.filePath = filePath;
    job.size = stat.size;
    job.ext = ext;
    job.filename = filename;
  }

  return { filePath, size: stat.size, ext, filename };
}

async function downloadViaExtractorToTemp(target, options) {
  return downloadViaExtractorToTempProgress(null, target, options);
}

function fetchRemote(targetUrl, method = "GET", redirectCount = 0) {
  return resolveSafeUrl(targetUrl.toString()).then(({ parsed, addresses }) => new Promise((resolve, reject) => {
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      parsed,
      {
        method,
        headers: {
          "User-Agent": "MediaDownloader/1.0 (personal)",
          Accept: "image/*,video/*,audio/*,*/*",
        },
        timeout: 30000,
        // Pin the connection to an address that was checked above. This closes
        // the DNS-rebinding gap between validation and socket connection.
        lookup: (_hostname, options, callback) => {
          if (options && options.all) {
            callback(null, addresses.map(({ address, family }) => ({ address, family })));
            return;
          }
          callback(null, addresses[0].address, addresses[0].family);
        },
      },
      (upstream) => {
        const status = upstream.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
          upstream.resume();
          if (redirectCount >= 10) {
            reject(new Error("Trop de redirections."));
            return;
          }
          try {
            const next = new URL(upstream.headers.location, parsed);
            // fetchRemote validates and pins every redirect destination.
            resolve(fetchRemote(next, method, redirectCount + 1));
          } catch (err) {
            reject(err);
          }
          return;
        }
        resolve(upstream);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Délai dépassé."));
    });
    req.on("error", reject);
    req.end();
  }));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  if (urlPath === "/") urlPath = "/index.html";

  const normalizedPublicDir = path.normalize(PUBLIC_DIR) + path.sep;
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  if (!filePath.startsWith(normalizedPublicDir) && filePath !== path.normalize(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
    };

    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function inspectViaGet(parsed) {
  const getRes = await fetchRemote(parsed, "GET");
  const getType = getRes.headers["content-type"] || "";
  const getKind = classify(getType);
  const getLen = Number(getRes.headers["content-length"] || 0);
  const disposition = getRes.headers["content-disposition"];
  const status = getRes.statusCode || 0;
  getRes.destroy();

  if (status >= 400) {
    throw new Error(`Le serveur distant a répondu ${status}.`);
  }

  if (!getKind) {
    throw new Error("Ce lien n'est pas un média direct.");
  }

  if (getLen > MAX_BYTES) {
    throw new Error("Fichier trop volumineux (max 500 Mo).");
  }

  return {
    ok: true,
    source: "direct",
    platform: "Lien direct",
    type: getKind,
    mime: getType.split(";")[0].trim(),
    size: getLen || null,
    filename: guessFilename(parsed, getType, disposition),
    previewUrl: `/api/preview?url=${encodeURIComponent(parsed.toString())}`,
    downloadUrl: `/api/download?url=${encodeURIComponent(parsed.toString())}`,
  };
}

async function inspectDirect(target) {
  const parsed = await assertSafeUrl(target);

  let upstream;
  try {
    upstream = await fetchRemote(parsed, "HEAD");
  } catch {
    if (looksLikeDirectMedia(target)) return inspectViaGet(parsed);
    throw new Error("Pas un média direct.");
  }

  const contentType = upstream.headers["content-type"] || "";
  const contentLength = Number(upstream.headers["content-length"] || 0);
  const kind = classify(contentType);
  const status = upstream.statusCode || 0;
  upstream.resume();

  // Pages HTML (YouTube, TikTok, etc.) → pas du direct
  if (/text\/html|application\/xhtml/i.test(contentType)) {
    throw new Error("Pas un média direct.");
  }

  if (status >= 400 || !kind) {
    if (looksLikeDirectMedia(target) || status === 405) {
      return inspectViaGet(parsed);
    }
    throw new Error("Pas un média direct.");
  }

  if (contentLength > MAX_BYTES) {
    throw new Error("Fichier trop volumineux (max 500 Mo).");
  }

  return {
    ok: true,
    source: "direct",
    platform: "Lien direct",
    type: kind,
    mime: contentType.split(";")[0].trim(),
    size: contentLength || null,
    filename: guessFilename(parsed, contentType, upstream.headers["content-disposition"]),
    previewUrl: `/api/preview?url=${encodeURIComponent(parsed.toString())}`,
    downloadUrl: `/api/download?url=${encodeURIComponent(parsed.toString())}`,
  };
}

async function handleInspect(req, res, target) {
  await assertSafeUrl(target);

  // 1) Média binaire direct (content-type image/video/audio)
  try {
    const direct = await inspectDirect(target);
    if (direct && direct.ok) {
      return sendJson(res, 200, direct);
    }
  } catch {
    // pas un fichier direct → extracteur
  }

  // 2) Extracteur multi-sites (YouTube, TikTok, Insta, Pinterest, …)
  try {
    return sendJson(res, 200, await inspectViaExtractor(target));
  } catch (extractorErr) {
    return sendJson(res, 400, {
      error:
        extractorErr.message ||
        "Impossible de récupérer ce média (privé, protégé, ou non supporté).",
    });
  }
}

async function handleStream(req, res, target, asDownload) {
  if (activeRemoteStreams >= MAX_ACTIVE_STREAMS) {
    return sendJson(res, 429, { error: "Trop de téléchargements simultanés." });
  }
  activeRemoteStreams += 1;
  let streamReleased = false;
  const releaseStream = () => {
    if (streamReleased) return;
    streamReleased = true;
    activeRemoteStreams -= 1;
  };
  res.once("close", releaseStream);

  const parsed = await assertSafeUrl(target);
  const upstream = await fetchRemote(parsed, "GET");
  const contentType = upstream.headers["content-type"] || "application/octet-stream";
  const contentLength = Number(upstream.headers["content-length"] || 0);
  const kind = classify(contentType);

  if (upstream.statusCode && upstream.statusCode >= 400) {
    upstream.resume();
    return sendJson(res, 400, { error: `Échec distant (${upstream.statusCode}).` });
  }

  if (!kind) {
    upstream.destroy();
    return sendJson(res, 400, {
      error: "Pas un média direct — utilise Analyser puis Télécharger.",
    });
  }

  if (contentLength > MAX_BYTES) {
    upstream.destroy();
    return sendJson(res, 400, { error: "Fichier trop volumineux (max 500 Mo)." });
  }

  const filename = guessFilename(parsed, contentType, upstream.headers["content-disposition"]);
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };

  if (contentLength) headers["Content-Length"] = contentLength;
  if (asDownload) {
    headers["Content-Disposition"] = buildContentDisposition(filename);
  }

  res.writeHead(200, headers);

  let transferred = 0;
  upstream.on("data", (chunk) => {
    transferred += chunk.length;
    if (transferred > MAX_BYTES) {
      upstream.destroy();
      res.destroy();
      return;
    }
    if (!res.write(chunk)) upstream.pause();
  });
  res.on("drain", () => upstream.resume());
  upstream.on("end", () => res.end());
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 500, { error: "Erreur de lecture." });
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

function mimeFromExt(ext) {
  const map = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

async function handleExtractDownload(req, res, target, options, suggestedTitle) {
  const opts = options || {
    mode: "video",
    height: 0,
    container: "mp4",
    audioFormat: "mp3",
  };

  const { filePath, size, ext } = await downloadViaExtractorToTemp(target, opts);
  const filename =
    sanitizeFilename(suggestedTitle || "media") +
    (ext || (opts.mode === "audio" ? `.${opts.audioFormat}` : `.${opts.container}`));

  res.writeHead(200, {
    "Content-Type": mimeFromExt(ext),
    "Content-Length": size,
    "Content-Disposition": buildContentDisposition(filename),
    "Cache-Control": "no-store",
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  const cleanup = () => {
    fs.unlink(filePath, () => {});
  };
  stream.on("close", cleanup);
  stream.on("error", () => {
    cleanup();
    if (!res.headersSent) sendJson(res, 500, { error: "Erreur d'envoi du fichier." });
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableEnded) stream.destroy();
    cleanup();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedReq = new URL(req.url, `http://localhost:${PORT}`);
    if (parsedReq.pathname === "/health" && req.method === "GET") {
      await pool.query("SELECT 1");
      return sendJson(res, 200, { ok: true });
    }

    if (ACCOUNT_API_PATHS.has(parsedReq.pathname)) {
      const handled = await handleAccountApi(req, res, parsedReq);
      if (handled !== false) return;
      return sendJson(res, 405, { error: "Méthode non autorisée." });
    }

    const protectedPages = new Set(["/", "/index.html", "/profile.html"]);
    const needsSession = parsedReq.pathname.startsWith("/api/") ||
      protectedPages.has(parsedReq.pathname) || parsedReq.pathname === "/account.html";
    const auth = needsSession ? await readSession(req) : null;
    if (parsedReq.pathname.startsWith("/api/") && !auth) {
      return sendJson(res, 401, { error: "Connexion requise." });
    }

    if (req.method === "GET" && protectedPages.has(parsedReq.pathname) && !auth) {
      res.writeHead(302, { Location: "/account.html", "Cache-Control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && parsedReq.pathname === "/account.html" && auth) {
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }

    if (parsedReq.pathname === "/api/inspect" && req.method === "GET") {
      const target = parsedReq.searchParams.get("url");
      if (!target) return sendJson(res, 400, { error: "Paramètre url manquant." });
      return await handleInspect(req, res, target);
    }

    if (parsedReq.pathname === "/api/preview" && req.method === "GET") {
      const target = parsedReq.searchParams.get("url");
      if (!target) return sendJson(res, 400, { error: "Paramètre url manquant." });
      return await handleStream(req, res, target, false);
    }

    if (parsedReq.pathname === "/api/download" && req.method === "GET") {
      const target = parsedReq.searchParams.get("url");
      if (!target) return sendJson(res, 400, { error: "Paramètre url manquant." });
      return await handleStream(req, res, target, true);
    }

    if (parsedReq.pathname === "/api/job/start" && req.method === "GET") {
      const target = parsedReq.searchParams.get("url");
      if (!target) return sendJson(res, 400, { error: "Paramètre url manquant." });
      const occupiedJobs = [...activeJobs.values()].filter(
        (job) => job.status === "downloading" || job.status === "ready"
      ).length;
      if (occupiedJobs >= MAX_ACTIVE_JOBS) {
        return sendJson(res, 429, { error: "Trop d’extractions en cours. Réessaie après un téléchargement." });
      }

      const options = parseDownloadOptions(parsedReq.searchParams);
      const suggestedTitle = parsedReq.searchParams.get("title") || "media";
      const jobId = crypto.randomBytes(12).toString("hex");

      const job = {
        id: jobId,
        ownerId: auth.user.id,
        status: "downloading",
        percent: 0,
        totalSize: "",
        speed: "",
        eta: "",
        createdAt: Date.now(),
        filePath: null,
        size: 0,
        filename: "media",
        error: null,
      };

      activeJobs.set(jobId, job);

      downloadViaExtractorToTempProgress(jobId, target, options, suggestedTitle).catch((err) => {
        job.status = "error";
        job.error = err.message || "Échec du téléchargement sur le serveur.";
      });

      return sendJson(res, 200, { ok: true, jobId });
    }

    if (parsedReq.pathname === "/api/job/status" && req.method === "GET") {
      const jobId = parsedReq.searchParams.get("id");
      const job = activeJobs.get(jobId);
      if (!job || job.ownerId !== auth.user.id) return sendJson(res, 404, { error: "Job non trouvé." });

      return sendJson(res, 200, {
        status: job.status,
        percent: Math.min(100, Math.max(0, Math.round((job.percent || 0) * 10) / 10)),
        totalSize: job.totalSize,
        speed: job.speed,
        eta: job.eta,
        filename: job.filename,
        size: job.size,
        error: job.error,
      });
    }

    if (parsedReq.pathname === "/api/job/download" && req.method === "GET") {
      const jobId = parsedReq.searchParams.get("id");
      const job = activeJobs.get(jobId);
      if (!job || job.ownerId !== auth.user.id || job.status !== "ready" || !job.filePath) {
        return sendJson(res, 400, { error: "Fichier pas encore prêt ou expiré." });
      }

      const filePath = job.filePath;
      const filename = job.filename;
      const size = job.size;
      const ext = job.ext || path.extname(filePath);

      res.writeHead(200, {
        "Content-Type": mimeFromExt(ext),
        "Content-Length": size,
        "Content-Disposition": buildContentDisposition(filename),
        "Cache-Control": "no-store",
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      const cleanup = () => {
        fs.unlink(filePath, () => {});
        activeJobs.delete(jobId);
      };

      stream.on("close", cleanup);
      stream.on("error", () => {
        cleanup();
        if (!res.headersSent) sendJson(res, 500, { error: "Erreur d'envoi du fichier." });
        else res.destroy();
      });

      res.on("close", () => {
        if (!res.writableEnded) stream.destroy();
        cleanup();
      });

      return;
    }

    if (req.method === "GET") return serveStatic(req, res);

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.statusCode, { error: err.message });
    }
    console.error("Erreur interne pendant le traitement de la requête :", err);
    if (res.headersSent) return res.destroy();
    sendJson(res, 500, { error: "Erreur interne du serveur." });
  }
});

function isLoopbackHost(host) {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  if (net.isIPv4(normalized)) return normalized.startsWith("127.");
  if (net.isIPv6(normalized)) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }
  return false;
}

if (!APP_PASSWORD && !isLoopbackHost(HOST)) {
  console.error("APP_PASSWORD (code d’invitation) est obligatoire lorsque HOST n’est pas une adresse locale.");
  process.exit(1);
}

initializeDatabase().then(() => {
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Media Downloader → http://${displayHost}:${PORT}`);
  });
}).catch((err) => {
  console.error("Impossible de démarrer sans PostgreSQL. Vérifie la connexion et les variables PG*/DATABASE_URL.");
  if (/client password must be a string/i.test(err.message || "")) {
    console.error("PostgreSQL exige un mot de passe. Définis PGPASSWORD ou POSTGRES_PASSWORD dans .env.");
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
