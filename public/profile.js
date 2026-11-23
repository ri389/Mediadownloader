const profileStatus = document.getElementById("profileStatus");

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
  } catch {
    window.location.replace("/account.html");
  }
}

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
