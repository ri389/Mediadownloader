const form = document.getElementById("grabForm");
const urlInput = document.getElementById("urlInput");
const inspectBtn = document.getElementById("inspectBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const previewWrap = document.getElementById("previewWrap");
const filenameEl = document.getElementById("filename");
const detailsEl = document.getElementById("details");
const downloadBtn = document.getElementById("downloadBtn");
const optionsPanel = document.getElementById("optionsPanel");
const modeVideoBtn = document.getElementById("modeVideo");
const modeAudioBtn = document.getElementById("modeAudio");
const videoOptions = document.getElementById("videoOptions");
const audioOptions = document.getElementById("audioOptions");
const resolutionSelect = document.getElementById("resolutionSelect");
const containerSelect = document.getElementById("containerSelect");
const audioFormatSelect = document.getElementById("audioFormatSelect");

let currentMedia = null;
let selectedMode = "video";

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "taille inconnue";
  const units = ["o", "Ko", "Mo", "Go"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function setStatus(message, ok = false) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("ok", ok);
}

function clearResult() {
  resultEl.hidden = true;
  previewWrap.innerHTML = "";
  currentMedia = null;
  optionsPanel.hidden = true;
  downloadBtn.disabled = false;
  downloadBtn.textContent = "Télécharger";
}

function typeLabel(type) {
  if (type === "image") return "Image";
  if (type === "audio") return "Audio";
  return "Vidéo";
}

function buildDetails(data) {
  const parts = [];
  if (data.platform) parts.push(data.platform);
  parts.push(typeLabel(data.type));
  if (data.channel) parts.push(data.channel);
  if (data.duration) parts.push(data.duration);
  if (data.mime) parts.push(data.mime);
  parts.push(formatSize(data.size));
  return parts.join(" · ");
}

function setMode(mode) {
  selectedMode = mode;
  modeVideoBtn.classList.toggle("active", mode === "video");
  modeAudioBtn.classList.toggle("active", mode === "audio");
  videoOptions.hidden = mode !== "video";
  audioOptions.hidden = mode !== "audio";
  updateDownloadLabel();
}

function updateDownloadLabel() {
  if (!currentMedia) return;
  if (currentMedia.source !== "extractor" || currentMedia.type === "image") {
    downloadBtn.textContent = "Télécharger";
    return;
  }
  if (selectedMode === "audio") {
    const fmt = audioFormatSelect.value.toUpperCase();
    downloadBtn.textContent = `Télécharger l’audio (${fmt})`;
  } else {
    const res = resolutionSelect.selectedOptions[0]?.textContent || "meilleure";
    const container = containerSelect.value.toUpperCase();
    downloadBtn.textContent = `Télécharger ${res} · ${container}`;
  }
}

function setupOptions(data) {
  const choices = data.choices;
  if (!choices || data.type === "image" || data.source !== "extractor") {
    optionsPanel.hidden = true;
    return;
  }

  optionsPanel.hidden = false;

  resolutionSelect.innerHTML = "";
  const resolutions = choices.resolutions?.length
    ? choices.resolutions
    : [{ height: 0, label: "Meilleure disponible" }];
  for (const r of resolutions) {
    const opt = document.createElement("option");
    opt.value = String(r.height);
    opt.textContent = r.label;
    resolutionSelect.appendChild(opt);
  }

  containerSelect.innerHTML = "";
  for (const c of choices.videoContainers || ["mp4", "webm", "mkv"]) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c.toUpperCase();
    containerSelect.appendChild(opt);
  }

  audioFormatSelect.innerHTML = "";
  for (const a of choices.audioFormats || ["mp3", "m4a", "opus", "wav"]) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a.toUpperCase();
    audioFormatSelect.appendChild(opt);
  }

  const defaults = choices.defaults || {};
  if (defaults.height != null) resolutionSelect.value = String(defaults.height);
  if (defaults.container) containerSelect.value = defaults.container;
  if (defaults.audioFormat) audioFormatSelect.value = defaults.audioFormat;

  modeVideoBtn.hidden = !choices.canVideo;
  modeAudioBtn.hidden = !choices.canAudio;

  if (choices.canVideo) setMode("video");
  else if (choices.canAudio) setMode("audio");
  else optionsPanel.hidden = true;

  updateDownloadLabel();
}

modeVideoBtn.addEventListener("click", () => setMode("video"));
modeAudioBtn.addEventListener("click", () => setMode("audio"));
resolutionSelect.addEventListener("change", updateDownloadLabel);
containerSelect.addEventListener("change", updateDownloadLabel);
audioFormatSelect.addEventListener("change", updateDownloadLabel);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  clearResult();
  setStatus("Analyse du lien…", true);
  inspectBtn.disabled = true;

  try {
    const res = await fetch(`/api/inspect?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Impossible d'analyser ce lien.");
    }

    currentMedia = data;
    setStatus(
      data.source === "extractor"
        ? `${data.platform || "Média"} trouvé. Choisis tes options puis télécharge.`
        : "Média détecté.",
      true
    );
    filenameEl.textContent = data.title || data.filename;
    detailsEl.textContent = buildDetails(data);
    setupOptions(data);

    previewWrap.innerHTML = "";
    if (data.source === "extractor" || data.type === "image") {
      if (data.previewUrl) {
        const img = document.createElement("img");
        img.src = data.previewUrl;
        img.alt = data.filename || data.title || "Aperçu";
        img.onerror = () => {
          previewWrap.innerHTML = "<p class='hint' style='text-align:center;padding:2rem;'>Aperçu indisponible</p>";
        };
        previewWrap.appendChild(img);
      } else {
        previewWrap.textContent = "Pas d’aperçu disponible";
      }
    } else if (data.type === "audio") {
      const audio = document.createElement("audio");
      audio.src = data.previewUrl;
      audio.controls = true;
      previewWrap.appendChild(audio);
    } else {
      const video = document.createElement("video");
      video.src = data.previewUrl;
      video.controls = true;
      video.playsInline = true;
      previewWrap.appendChild(video);
    }

    resultEl.hidden = false;
  } catch (err) {
    setStatus(err.message || "Erreur inattendue.");
  } finally {
    inspectBtn.disabled = false;
  }
});

const progressCard = document.getElementById("progressCard");
const progressBadge = document.getElementById("progressBadge");
const progressTitle = document.getElementById("progressTitle");
const progressPercent = document.getElementById("progressPercent");
const progressFill = document.getElementById("progressFill");
const progressSub = document.getElementById("progressSub");
const progressSpeed = document.getElementById("progressSpeed");

function showProgressCard(badgeText, titleText, percent, subText, speedText = "") {
  if (!progressCard) return;
  progressCard.hidden = false;
  if (badgeText) progressBadge.textContent = badgeText;
  if (titleText) progressTitle.textContent = titleText;
  if (percent != null) {
    const val = Math.min(100, Math.max(0, Math.round(percent)));
    progressPercent.textContent = `${val}%`;
    progressFill.style.width = `${val}%`;
  }
  if (subText) progressSub.textContent = subText;
  progressSpeed.textContent = speedText || "";
}

function hideProgressCard(delay = 0) {
  if (!progressCard) return;
  if (delay <= 0) {
    progressCard.hidden = true;
    progressFill.style.width = "0%";
    progressPercent.textContent = "0%";
    return;
  }
  setTimeout(() => {
    progressCard.hidden = true;
    progressFill.style.width = "0%";
    progressPercent.textContent = "0%";
  }, delay);
}

function buildDownloadUrl() {
  if (!currentMedia?.downloadUrl) return null;

  if (currentMedia.source !== "extractor" || currentMedia.type === "image") {
    return currentMedia.downloadUrl;
  }

  const params = new URLSearchParams();
  const base = new URL(currentMedia.downloadUrl, window.location.origin);
  params.set("url", base.searchParams.get("url"));
  params.set("mode", selectedMode);
  params.set("title", currentMedia.title || currentMedia.filename || "media");

  if (selectedMode === "audio") {
    params.set("audioFormat", audioFormatSelect.value);
  } else {
    params.set("height", resolutionSelect.value || "0");
    params.set("container", containerSelect.value || "mp4");
  }

  return `/api/extract/download?${params.toString()}`;
}

function suggestedFilename() {
  const base = (currentMedia.title || currentMedia.filename || "media").replace(
    /\.[^.]+$/,
    ""
  );
  if (currentMedia.source !== "extractor" || currentMedia.type === "image") {
    return currentMedia.filename || "media.bin";
  }
  if (selectedMode === "audio") {
    return `${base}.${audioFormatSelect.value}`;
  }
  return `${base}.${containerSelect.value}`;
}

downloadBtn.addEventListener("click", async () => {
  if (!currentMedia) return;

  downloadBtn.disabled = true;
  setStatus("");
  hideProgressCard(0);

  const isExtractor = currentMedia.source === "extractor";

  if (isExtractor && currentMedia.type !== "image") {
    const params = new URLSearchParams();
    const base = new URL(currentMedia.downloadUrl, window.location.origin);
    params.set("url", base.searchParams.get("url"));
    params.set("mode", selectedMode);
    params.set("title", currentMedia.title || currentMedia.filename || "media");

    if (selectedMode === "audio") {
      params.set("audioFormat", audioFormatSelect.value);
    } else {
      params.set("height", resolutionSelect.value || "0");
      params.set("container", containerSelect.value || "mp4");
    }

    showProgressCard("Extraction", "Extraction du média sur le serveur…", 0, "Connexion au serveur…");

    try {
      const startRes = await fetch(`/api/job/start?${params.toString()}`);
      const startData = await startRes.json();
      if (!startRes.ok || !startData.ok || !startData.jobId) {
        throw new Error(startData.error || "Impossible de démarrer le téléchargement.");
      }

      const jobId = startData.jobId;

      const finalJob = await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/job/status?id=${jobId}`);
            if (!statusRes.ok) {
              clearInterval(timer);
              return reject(new Error("Erreur de suivi du téléchargement."));
            }
            const data = await statusRes.json();
            if (data.status === "error") {
              clearInterval(timer);
              return reject(new Error(data.error || "Erreur pendant l'extraction."));
            }

            const pct = data.percent || 0;
            const sub = data.totalSize
              ? `${data.totalSize}${data.eta ? ' · ETA ' + data.eta : ''}`
              : 'Extraction en cours…';
            showProgressCard("Extraction", `Récupération depuis ${currentMedia.platform || 'le site'}…`, pct, sub, data.speed);

            if (data.status === "ready") {
              clearInterval(timer);
              resolve(data);
            }
          } catch (e) {
            clearInterval(timer);
            reject(e);
          }
        }, 300);
      });

      showProgressCard("Transfert", "Envoi vers votre appareil…", 0, "Préparation du fichier…");
      if (progressBadge) progressBadge.classList.add("ready");

      const fileRes = await fetch(`/api/job/download?id=${jobId}`);
      if (!fileRes.ok) throw new Error("Erreur de récupération du fichier final.");

      const contentLength = Number(fileRes.headers.get("Content-Length") || finalJob.size || 0);
      const reader = fileRes.body.getReader();
      const chunks = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.length;

        if (contentLength > 0) {
          const transferPct = Math.min(100, Math.round((receivedBytes / contentLength) * 100));
          showProgressCard(
            "Transfert",
            "Transfert vers votre appareil…",
            transferPct,
            `${formatSize(receivedBytes)} sur ${formatSize(contentLength)}`
          );
        }
      }

      const blob = new Blob(chunks);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = finalJob.filename || suggestedFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);

      showProgressCard("Terminé", "Téléchargement terminé !", 100, "Fichier enregistré avec succès ! 🎉");
      setStatus("Téléchargement terminé avec succès !", true);
      hideProgressCard(3000);
    } catch (err) {
      hideProgressCard(0);
      setStatus(err.message || "Erreur de téléchargement.");
    } finally {
      downloadBtn.disabled = false;
      if (progressBadge) progressBadge.classList.remove("ready");
      updateDownloadLabel();
    }
  } else {
    const downloadUrl = buildDownloadUrl();
    if (!downloadUrl) return;

    showProgressCard("Téléchargement", "Téléchargement direct…", 0, "Initialisation…");

    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        let message = "Échec du téléchargement.";
        try {
          const err = await res.json();
          if (err.error) message = err.error;
        } catch {}
        throw new Error(message);
      }

      const contentLength = Number(res.headers.get("Content-Length") || 0);
      const reader = res.body.getReader();
      const chunks = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.length;

        if (contentLength > 0) {
          const pct = Math.min(100, Math.round((receivedBytes / contentLength) * 100));
          showProgressCard("Téléchargement", "Téléchargement du média…", pct, `${formatSize(receivedBytes)} / ${formatSize(contentLength)}`);
        } else {
          showProgressCard("Téléchargement", "Reconstitution du fichier…", 50, `${formatSize(receivedBytes)} reçus`);
        }
      }

      const blob = new Blob(chunks);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = suggestedFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);

      showProgressCard("Terminé", "Téléchargement terminé !", 100, "Fichier enregistré avec succès ! 🎉");
      setStatus("Téléchargement terminé.", true);
      hideProgressCard(3000);
    } catch (err) {
      hideProgressCard(0);
      setStatus(err.message || "Erreur de téléchargement.");
    } finally {
      downloadBtn.disabled = false;
      updateDownloadLabel();
    }
  }
});
