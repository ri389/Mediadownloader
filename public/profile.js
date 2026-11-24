const profileStatus = document.getElementById("profileStatus");
const YOUTUBE_COOKIE_CONSENT_VERSION = "2026-11-24-v1";

function setProfileStatus(message, ok = false) {
  profileStatus.textContent = message;
  profileStatus.hidden = !message;
  profileStatus.classList.toggle("ok", ok);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("Le serveur a renvoyé une réponse inattendue."); }
  if (!response.ok) throw new Error(data.error || "La requête a échoué.");
  return data;
}

function renderProfile(user) {
  document.getElementById("profileDisplayName").textContent = user.displayName;
  document.getElementById("profileUsername").textContent = `@${user.username}`;
  document.getElementById("profileAvatar").textContent = (user.displayName.trim()[0] || "M").toLocaleUpperCase();
  document.getElementById("displayNameInput").value = user.displayName;
  const date = new Date(user.createdAt);
  document.getElementById("profileCreated").textContent = `Compte créé le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(date)}`;
}

async function loadProfile() {
  try {
    const data = await requestJson("/api/profile");
    renderProfile(data.user);
    await loadYoutubeCookiesState();
  } catch {
    window.location.replace("/account.html");
  }
}

async function loadYoutubeCookiesState() {
  const state = document.getElementById("youtubeCookiesState");
  const form = document.getElementById("youtubeCookiesForm");
  const removeButton = document.getElementById("removeYoutubeCookiesButton");
  try {
    const data = await requestJson("/api/profile/youtube-cookies");
    const formControls = form.querySelectorAll("input, button");
    formControls.forEach((control) => { control.disabled = !data.enabled; });
    removeButton.hidden = !data.hasCookies;

    if (!data.enabled) {
      state.textContent = "Le stockage chiffré n’est pas activé sur ce serveur. L’exploitant doit configurer YOUTUBE_COOKIES_ENCRYPTION_KEY dans Railway avant l’envoi.";
    } else if (data.hasCookies && data.consentVersion !== YOUTUBE_COOKIE_CONSENT_VERSION) {
      state.textContent = "Les informations de consentement ont changé. Réimporte tes cookies et coche la case pour confirmer les nouvelles règles avant leur utilisation.";
    } else if (data.hasCookies) {
      const date = data.consentedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(data.consentedAt)) : "date inconnue";
      state.textContent = `Tes cookies YouTube sont enregistrés et chiffrés depuis le ${date}. Leur contenu n’est jamais affiché ici.`;
    } else {
      state.textContent = "Aucun cookie YouTube n’est enregistré. Les autres fonctions du service restent disponibles sans cookies.";
    }
  } catch (error) {
    state.textContent = error.message || "Impossible de vérifier le stockage des cookies.";
  }
}

document.getElementById("youtubeCookiesForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = document.getElementById("youtubeCookiesFile").files[0];
  const consent = document.getElementById("youtubeCookiesConsent").checked;
  const button = document.getElementById("saveYoutubeCookiesButton");
  if (!file || !consent) {
    setProfileStatus("Choisis le fichier cookies.txt et coche le consentement pour continuer.");
    return;
  }
  if (file.size > 256 * 1024) {
    setProfileStatus("Le fichier cookies.txt dépasse la taille maximale de 256 Ko.");
    return;
  }

  button.disabled = true;
  setProfileStatus("Envoi et chiffrement des cookies…", true);
  try {
    const contents = await file.text();
    const response = await fetch("/api/profile/youtube-cookies", {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-MediaDownloader-Consent": YOUTUBE_COOKIE_CONSENT_VERSION,
      },
      body: contents,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("Le serveur a renvoyé une réponse inattendue."); }
    if (!response.ok) throw new Error(data.error || "Impossible d’enregistrer les cookies.");
    form.reset();
    setProfileStatus("Cookies enregistrés. Ils ne seront utilisés que pour tes requêtes YouTube.", true);
    await loadYoutubeCookiesState();
  } catch (error) {
    setProfileStatus(error.message || "Impossible d’enregistrer les cookies.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("removeYoutubeCookiesButton").addEventListener("click", async () => {
  if (!window.confirm("Retirer ton consentement et supprimer tes cookies YouTube enregistrés ? Les extractions déjà en cours peuvent se terminer.")) return;
  const button = document.getElementById("removeYoutubeCookiesButton");
  button.disabled = true;
  setProfileStatus("Suppression des cookies…", true);
  try {
    await requestJson("/api/profile/youtube-cookies", { method: "DELETE", body: "{}" });
    setProfileStatus("Consentement retiré et cookies supprimés. Les extractions déjà en cours peuvent se terminer.", true);
    await loadYoutubeCookiesState();
  } catch (error) {
    setProfileStatus(error.message || "Impossible de supprimer les cookies.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("displayNameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  setProfileStatus("Enregistrement…", true);
  try {
    const data = await requestJson("/api/profile", {
      method: "POST",
      body: JSON.stringify({ displayName: document.getElementById("displayNameInput").value }),
    });
    renderProfile(data.user);
    setProfileStatus("Nom affiché mis à jour.", true);
  } catch (error) {
    setProfileStatus(error.message || "Impossible d’enregistrer le nom.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  setProfileStatus("Modification du mot de passe…", true);
  try {
    await requestJson("/api/profile/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: document.getElementById("currentPassword").value,
        newPassword: document.getElementById("newPassword").value,
      }),
    });
    document.getElementById("passwordForm").reset();
    setProfileStatus("Mot de passe modifié. Cette session reste ouverte.", true);
  } catch (error) {
    setProfileStatus(error.message || "Impossible de modifier le mot de passe.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try { await requestJson("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
  window.location.replace("/account.html");
});

loadProfile();
