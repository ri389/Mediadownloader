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
const resolutionSelectRoot = document.getElementById("resolutionSelect");
const containerSelectRoot = document.getElementById("containerSelect");
const audioFormatSelectRoot = document.getElementById("audioFormatSelect");

let currentMedia = null;
let selectedMode = "video";

class CustomSelect {
  constructor(root) {
    this.root = root;
    this.trigger = root.querySelector(".select-trigger");
    this.valueNode = root.querySelector(".select-value");
    this.menu = root.querySelector(".select-menu");
    this.options = [];
    this.currentValue = "";
    this.activeIndex = -1;
    this.typeahead = "";
    this.typeaheadTimer = null;

    this.trigger.addEventListener("click", () => {
      if (this.isOpen) this.close();
      else this.open();
    });
    this.trigger.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.menu.addEventListener("pointermove", (event) => {
      const option = event.target.closest(".select-option");
      if (option) this.setActive(Number(option.dataset.index));
    });
    this.menu.addEventListener("click", (event) => {
      const option = event.target.closest(".select-option");
      if (!option) return;
      this.value = this.options[Number(option.dataset.index)]?.value;
      this.close();
      this.trigger.focus({ preventScroll: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.root.contains(event.target)) this.close();
    });
  }

  get isOpen() {
    return !this.menu.hidden;
  }

  get value() {
    return this.currentValue;
  }

  set value(nextValue) {
    const index = this.options.findIndex((option) => option.value === String(nextValue));
    if (index < 0) return;
    const next = this.options[index].value;
    const changed = next !== this.currentValue;
    this.currentValue = next;
    this.activeIndex = index;
    this.render();
    if (changed) this.root.dispatchEvent(new Event("change", { bubbles: true }));
  }

  get selectedOptions() {
    const selected = this.options.find((option) => option.value === this.currentValue);
    return selected ? [{ textContent: selected.label }] : [];
  }

  addEventListener(type, listener, options) {
    this.root.addEventListener(type, listener, options);
  }

  setOptions(options, preferredValue) {
    this.options = options.map((option) => ({
      value: String(option.value),
      label: String(option.label),
    }));

    const fragment = document.createDocumentFragment();
    this.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "select-option";
      row.id = `${this.root.id}-option-${index}`;
      row.dataset.index = String(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.textContent = option.label;
      fragment.appendChild(row);
    });
    this.menu.replaceChildren(fragment);

    const preferredIndex = this.options.findIndex((option) => option.value === String(preferredValue));
    const currentIndex = this.options.findIndex((option) => option.value === this.currentValue);
    const selectedIndex = preferredIndex >= 0 ? preferredIndex : currentIndex >= 0 ? currentIndex : 0;
    this.currentValue = this.options[selectedIndex]?.value || "";
    this.activeIndex = selectedIndex;
    this.render();
  }

  render() {
    const selectedIndex = this.options.findIndex((option) => option.value === this.currentValue);
    this.valueNode.textContent = this.options[selectedIndex]?.label || "Choisir une option";
    this.options.forEach((option, index) => {
      const row = this.menu.children[index];
      const selected = index === selectedIndex;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
    });
    if (this.isOpen && this.activeIndex >= 0) this.setActive(this.activeIndex, false);
  }

  open() {
    if (!this.options.length) return;
    this.menu.hidden = false;
    this.root.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");
    const selectedIndex = this.options.findIndex((option) => option.value === this.currentValue);
    this.setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }

  close() {
    if (!this.isOpen) return;
    this.menu.hidden = true;
    this.root.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.removeAttribute("aria-activedescendant");
    this.menu.querySelectorAll(".is-active").forEach((option) => option.classList.remove("is-active"));
  }

  setActive(index, scroll = true) {
    if (index < 0 || index >= this.options.length) return;
    this.activeIndex = index;
    this.menu.querySelectorAll(".select-option").forEach((option, optionIndex) => {
      option.classList.toggle("is-active", optionIndex === index);
    });
    const activeOption = this.menu.children[index];
    this.trigger.setAttribute("aria-activedescendant", activeOption.id);
    if (scroll) activeOption.scrollIntoView({ block: "nearest" });
  }

  chooseActive() {
    if (this.activeIndex < 0) return;
    this.value = this.options[this.activeIndex].value;
    this.close();
  }

  handleKeydown(event) {
    if (event.key === "Tab") {
      this.close();
      return;
    }

    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault();
    } else if (event.key === "Escape") {
      if (this.isOpen) {
        event.preventDefault();
        this.close();
      }
      return;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.handleTypeahead(event.key);
      return;
    } else {
      return;
    }

    if (!this.options.length) return;
    if (event.key === "ArrowDown") {
      if (!this.isOpen) this.open();
      else this.setActive((this.activeIndex + 1) % this.options.length);
    } else if (event.key === "ArrowUp") {
      if (!this.isOpen) {
        this.open();
        this.setActive((this.activeIndex - 1 + this.options.length) % this.options.length);
      } else {
        this.setActive((this.activeIndex - 1 + this.options.length) % this.options.length);
      }
    } else if (event.key === "Home" || event.key === "End") {
      if (!this.isOpen) this.open();
      this.setActive(event.key === "Home" ? 0 : this.options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      if (this.isOpen) this.chooseActive();
      else this.open();
    }
  }

  handleTypeahead(character) {
    this.typeahead += character.toLocaleLowerCase();
    clearTimeout(this.typeaheadTimer);
    this.typeaheadTimer = setTimeout(() => { this.typeahead = ""; }, 700);

    const start = Math.max(0, this.activeIndex + 1);
    for (let offset = 0; offset < this.options.length; offset += 1) {
      const index = (start + offset) % this.options.length;
      if (this.options[index].label.toLocaleLowerCase().startsWith(this.typeahead)) {
        if (!this.isOpen) this.open();
        this.setActive(index);
        return;
      }
    }
  }
}

const resolutionSelect = new CustomSelect(resolutionSelectRoot);
const containerSelect = new CustomSelect(containerSelectRoot);
const audioFormatSelect = new CustomSelect(audioFormatSelectRoot);

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

function explainExtractionError(message) {
  const error = String(message || "Erreur inattendue.");
  if (/sign in to confirm\s+(?:you['’]re|you are)\s+not a bot/i.test(error)) {
    return "YouTube refuse la requête du serveur et demande une session. Dans Railway, vérifie les journaux du dernier démarrage : « Loaded from YTDLP_COOKIES_B64 » confirme que le fichier a été chargé. S’il est chargé, il peut être expiré ou YouTube peut bloquer les requêtes depuis Railway. Ne partage jamais ces cookies.";
  }
  if (/you might want to use a vpn or a proxy server|geo[- ]?restrict|not available (?:in your country|from your location)/i.test(error)) {
    return "La plateforme signale une restriction régionale ou indique que l’adresse IP du serveur n’est pas autorisée pour ce média. L’accès dépend des règles et de la région définies par la plateforme ; le service ne peut pas les contourner.";
  }
  if (/failed to extract any player response/i.test(error)) {
    return "YouTube n’a pas fourni de réponse de lecteur exploitable. Réessaie plus tard. Si l’erreur revient sur plusieurs vidéos, l’extracteur YouTube du serveur doit être actualisé ; certaines vidéos peuvent aussi être indisponibles ou bloquées depuis Railway.";
  }
  return error;
}

async function readApiJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.status === 401) {
      throw new Error("Authentification requise. Recharge la page et saisis le mot de passe de l’application.");
    }
    throw new Error(
      "L’API n’a pas répondu en JSON. Lance `npm start`, puis ouvre http://localhost:3847. Live Server (port 5500) ne sert pas l’API."
    );
  }
  return response.json();
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
  resolutionSelect.close();
  containerSelect.close();
  audioFormatSelect.close();
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

  const resolutions = choices.resolutions?.length
    ? choices.resolutions
    : [{ height: 0, label: "Meilleure disponible" }];
  const defaults = choices.defaults || {};
  resolutionSelect.setOptions(
    resolutions.map((option) => ({ value: option.height, label: option.label })),
    defaults.height == null ? "0" : String(defaults.height)
  );
  containerSelect.setOptions(
    (choices.videoContainers || ["mp4", "webm", "mkv"]).map((container) => ({
      value: container,
      label: container.toUpperCase(),
    })),
    defaults.container || "mp4"
  );
  audioFormatSelect.setOptions(
    (choices.audioFormats || ["mp3", "m4a", "opus", "wav"]).map((format) => ({
      value: format,
      label: format.toUpperCase(),
    })),
    defaults.audioFormat || "mp3"
  );

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
  if ((url.match(/https?:\/\//gi) || []).length > 1) {
    setStatus("Le champ contient plusieurs liens collés. Garde un seul lien, puis relance l’analyse.");
    urlInput.focus();
    return;
  }

  clearResult();
  setStatus("Analyse du lien…", true);
  inspectBtn.disabled = true;

  try {
    const res = await fetch(`/api/inspect?url=${encodeURIComponent(url)}`);
    const data = await readApiJson(res);

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
    setStatus(explainExtractionError(err.message || "Erreur inattendue."));
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

function startBrowserDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function showDownloadStarted() {
  hideProgressCard(0);
  setStatus("Téléchargement lancé dans le navigateur.", true);
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
      const startData = await readApiJson(startRes);
      if (!startRes.ok || !startData.ok || !startData.jobId) {
        throw new Error(startData.error || "Impossible de démarrer le téléchargement.");
      }

      const jobId = startData.jobId;

      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/job/status?id=${jobId}`);
            const data = await readApiJson(statusRes);
            if (!statusRes.ok) {
              clearInterval(timer);
              return reject(new Error(data.error || "Erreur de suivi du téléchargement."));
            }
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

      if (progressBadge) progressBadge.classList.add("ready");
      startBrowserDownload(`/api/job/download?id=${encodeURIComponent(jobId)}`);
      showDownloadStarted();
    } catch (err) {
      hideProgressCard(0);
      setStatus(explainExtractionError(err.message || "Erreur de téléchargement."));
    } finally {
      downloadBtn.disabled = false;
      if (progressBadge) progressBadge.classList.remove("ready");
      updateDownloadLabel();
    }
  } else {
    const downloadUrl = buildDownloadUrl();
    if (!downloadUrl) return;

    startBrowserDownload(downloadUrl);
    showDownloadStarted();
    downloadBtn.disabled = false;
    updateDownloadLabel();
  }
});
