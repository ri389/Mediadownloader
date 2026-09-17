const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PORT || 3847;
const MAX_BYTES = 500 * 1024 * 1024; // 500 Mo
const PUBLIC_DIR = path.join(__dirname, "public");
const TMP_DIR = path.join(os.tmpdir(), "grab-media");
function resolvePythonPath() {
  if (process.env.GRAB_PYTHON) return process.env.GRAB_PYTHON;
  const defaultWin = "C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
  if (fs.existsSync(defaultWin)) return defaultWin;
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

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const normalized = ip.replace(/^::ffff:/i, "");
  if (normalized === "::1" || normalized === "0.0.0.0" || normalized.startsWith("0.")) return true;
  if (normalized.startsWith("127.")) return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;
  if (normalized.startsWith("169.254.")) return true;
  const m = normalized.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")) {
    return true;
  }
  return false;
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

async function assertSafeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL invalide.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Seuls http et https sont autorisés.");
  }

  const hostname = parsed.hostname;
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Hôtes locaux interdits.");
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Impossible de résoudre l'hôte.");
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new Error("Adresse privée / locale interdite.");
    }
  }

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

setInterval(() => {
  const now = Date.now();
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

function runYtDlp(args, onProgress) {
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

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const lines = (stderr || stdout).trim().split("\n").filter(Boolean);
          const msg = lines[lines.length - 1] || "Site non supporté ou média inaccessible.";
          reject(new Error(msg.replace(/^ERROR:\s*/i, "")));
        }
      });
    });
  };

  return tryExec(PYTHON, ["-m", "yt_dlp", ...commonArgs])
    .catch(() => tryExec("yt-dlp", commonArgs))
    .catch(() => tryExec("python3", ["-m", "yt_dlp", ...commonArgs]));
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

async function inspectViaExtractor(target) {
  const cleanTarget = normalizeMediaUrl(target);
  await assertSafeUrl(cleanTarget);

  const { stdout } = await runYtDlp([
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
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

  const args = ["--no-playlist", "--no-warnings", "-o", outTemplate];

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

  await runYtDlp(args, (prog) => {
    if (job) {
      job.percent = prog.percent;
      job.totalSize = prog.totalSize;
      job.speed = prog.speed;
      job.eta = prog.eta;
    }
  });

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

function fetchRemote(targetUrl, method = "GET") {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.protocol === "https:" ? https : http;
    const req = lib.request(
      targetUrl,
      {
        method,
        headers: {
          "User-Agent": "MediaDownloader/1.0 (personal)",
          Accept: "image/*,video/*,audio/*,*/*",
        },
        timeout: 30000,
      },
      (upstream) => {
        const status = upstream.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
          upstream.resume();
          try {
            const next = new URL(upstream.headers.location, targetUrl);
            resolve(fetchRemote(next, method));
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
  });
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
    res.write(chunk);
  });
  upstream.on("end", () => res.end());
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 500, { error: "Erreur de lecture." });
    else res.destroy();
  });
  req.on("close", () => upstream.destroy());
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
  req.on("close", () => {
    stream.destroy();
    cleanup();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedReq = new URL(req.url, `http://localhost:${PORT}`);

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

      const options = parseDownloadOptions(parsedReq.searchParams);
      const suggestedTitle = parsedReq.searchParams.get("title") || "media";
      const jobId = crypto.randomBytes(12).toString("hex");

      const job = {
        id: jobId,
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
      if (!job) return sendJson(res, 404, { error: "Job non trouvé." });

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
      if (!job || job.status !== "ready" || !job.filePath) {
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

      req.on("close", () => {
        stream.destroy();
        cleanup();
      });

      return;
    }

    if (req.method === "GET") return serveStatic(req, res);

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Erreur inconnue." });
  }
});

server.listen(PORT, () => {
  console.log(`Media Downloader → http://localhost:${PORT}`);
});
