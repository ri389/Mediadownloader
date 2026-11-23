const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const authStatus = document.getElementById("authStatus");
const inviteField = document.getElementById("inviteField");

function showStatus(message, ok = false) {
  authStatus.textContent = message;
  authStatus.hidden = !message;
  authStatus.classList.toggle("ok", ok);
}

function setMode(mode) {
  const isLogin = mode === "login";
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
  loginTab.classList.toggle("active", isLogin);
  registerTab.classList.toggle("active", !isLogin);
  loginTab.setAttribute("aria-selected", String(isLogin));
  registerTab.setAttribute("aria-selected", String(!isLogin));
  showStatus("");
}

async function apiJson(url, options = {}) {
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

loginTab.addEventListener("click", () => setMode("login"));
registerTab.addEventListener("click", () => setMode("register"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  showStatus("Connexion en cours…", true);
  try {
    await apiJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("loginUsername").value,
        password: document.getElementById("loginPassword").value,
      }),
    });
    window.location.replace("/");
  } catch (error) {
    showStatus(error.message || "Connexion impossible.");
  } finally {
    button.disabled = false;
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  showStatus("Création du compte…", true);
  try {
    await apiJson("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: document.getElementById("registerDisplayName").value,
        username: document.getElementById("registerUsername").value,
        password: document.getElementById("registerPassword").value,
        inviteCode: document.getElementById("inviteCode").value,
      }),
    });
    window.location.replace("/");
  } catch (error) {
    showStatus(error.message || "Création du compte impossible.");
  } finally {
    button.disabled = false;
  }
});

async function initializeAccountPage() {
  try {
    const [config, session] = await Promise.all([
      apiJson("/api/auth/config"),
      fetch("/api/auth/me", { credentials: "same-origin" }),
    ]);
    if (session.ok) {
      window.location.replace("/");
      return;
    }
    inviteField.hidden = !config.inviteRequired;
    document.getElementById("inviteCode").required = config.inviteRequired;
  } catch (error) {
    showStatus(error.message || "Le serveur est momentanément inaccessible.");
  }
}

initializeAccountPage();
