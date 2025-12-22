// profile.js (corrigido: adiciona logout e usa replace no redirect)
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  updatePassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;
let profileData = null;
let selectedColor = null;

function goToLogin(withNext = false) {
  const file = window.location.pathname.split("/").pop() || "profile.html";
  const next = encodeURIComponent(file + window.location.search);
  const target = withNext ? `index.html?next=${next}` : "index.html";
  window.location.replace(target);
}

function showToast(message, variant = "success") {
  const toast = document.getElementById("toast");
  const msgEl = document.getElementById("toast-message");
  if (!toast || !msgEl) return;

  msgEl.textContent = message;
  const iconSpan = toast.querySelector(".toast-icon i");
  if (iconSpan) {
    iconSpan.className =
      variant === "error"
        ? "ph-bold ph-x-circle"
        : variant === "warning"
        ? "ph-bold ph-warning-circle"
        : "ph-bold ph-check-circle";
  }

  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2600);
}

function bindLogoutIfExists() {
  const candidates = [
    document.getElementById("btn-logout"),
    document.getElementById("logout-btn"),
    document.getElementById("btnLogout"),
    document.getElementById("logout")
  ].filter(Boolean);

  candidates.forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async () => {
      try {
        await signOut(auth);
      } finally {
        goToLogin(false);
      }
    });
  });
}

onAuthStateChanged(auth, async (user) => {
  bindLogoutIfExists();

  if (!user) {
    goToLogin(true);
    return;
  }

  currentUser = user;

  const snap = await get(ref(db, `users/${user.uid}`));
  profileData =
    snap.val() || {
      email: user.email,
      name: user.email ? user.email.split("@")[0] : "Usuário",
      color: "#276b38"
    };

  const name = profileData.name || (user.email ? user.email.split("@")[0] : "Usuário");
  const email = profileData.email || user.email;
  const color = profileData.color || "#276b38";
  selectedColor = color;

  const avatarSmall = document.getElementById("user-avatar");
  const avatarBig = document.getElementById("profile-avatar-big");
  const userNameSpan = document.getElementById("user-name");
  const profileName = document.getElementById("profile-name");
  const profileEmail = document.getElementById("profile-email");

  if (profileName) profileName.textContent = name;
  if (profileEmail) profileEmail.textContent = email;

  if (avatarSmall) {
    avatarSmall.style.backgroundColor = color;
    avatarSmall.textContent = (name || "?")[0].toUpperCase();
  }
  if (avatarBig) {
    avatarBig.style.backgroundColor = color;
    avatarBig.textContent = (name || "?")[0].toUpperCase();
  }
  if (userNameSpan) userNameSpan.textContent = name;

  document.documentElement.style.setProperty("--accent", color);

  const preview = document.getElementById("color-preview");
  const hexLabel = document.getElementById("color-hex");
  if (preview) preview.style.backgroundColor = color;
  if (hexLabel) hexLabel.textContent = color;

  attachColorPicker();
  attachActions();
});

function attachColorPicker() {
  const gradient = document.getElementById("color-gradient");
  const thumb = document.getElementById("color-thumb");
  const preview = document.getElementById("color-preview");
  const hexLabel = document.getElementById("color-hex");

  if (!gradient || !thumb) return;

  let dragging = false;

  function handlePick(evt) {
    const rect = gradient.getBoundingClientRect();
    let x = evt.clientX - rect.left;
    if (x < 0) x = 0;
    if (x > rect.width) x = rect.width;

    const percent = x / rect.width;
    const hue = Math.round(percent * 360);
    const colorHsl = `hsl(${hue}, 80%, 50%)`;
    const rgb = hslToRgb(hue / 360, 0.8, 0.5);
    const colorHex = rgbToHex(rgb);

    thumb.style.left = `${percent * 100}%`;
    thumb.style.background = colorHsl;
    if (preview) preview.style.backgroundColor = colorHex;
    selectedColor = colorHex;
    if (hexLabel) hexLabel.textContent = colorHex;
  }

  if (!gradient.dataset.bound) {
    gradient.dataset.bound = "true";
    gradient.addEventListener("mousedown", (evt) => {
      dragging = true;
      handlePick(evt);
    });
    window.addEventListener("mousemove", (evt) => {
      if (!dragging) return;
      handlePick(evt);
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }
}

function attachActions() {
  const btnSaveColor = document.getElementById("btn-save-color");
  if (btnSaveColor && !btnSaveColor.dataset.bound) {
    btnSaveColor.dataset.bound = "true";
    btnSaveColor.addEventListener("click", async () => {
      if (!currentUser || !selectedColor) return;
      try {
        await update(ref(db, `users/${currentUser.uid}`), { color: selectedColor });
        document.documentElement.style.setProperty("--accent", selectedColor);
        const avatarSmall = document.getElementById("user-avatar");
        const avatarBig = document.getElementById("profile-avatar-big");
        if (avatarSmall) avatarSmall.style.backgroundColor = selectedColor;
        if (avatarBig) avatarBig.style.backgroundColor = selectedColor;
        showToast("Cor atualizada.");
      } catch (err) {
        console.error(err);
        showToast("Erro ao salvar cor.", "error");
      }
    });
  }

  const btnSavePassword = document.getElementById("btn-save-password");
  if (btnSavePassword && !btnSavePassword.dataset.bound) {
    btnSavePassword.dataset.bound = "true";
    btnSavePassword.addEventListener("click", async () => {
      const newPass = document.getElementById("new-password").value;
      const confirm = document.getElementById("confirm-password").value;
      const status = document.getElementById("password-status");

      if (!newPass || newPass.length < 6) {
        if (status) status.textContent = "A senha deve ter pelo menos 6 caracteres.";
        showToast("Senha muito curta.", "warning");
        return;
      }
      if (newPass !== confirm) {
        if (status) status.textContent = "As senhas não conferem.";
        showToast("As senhas não conferem.", "warning");
        return;
      }

      try {
        await updatePassword(currentUser, newPass);
        if (status) status.textContent = "Senha atualizada com sucesso.";
        document.getElementById("new-password").value = "";
        document.getElementById("confirm-password").value = "";
        showToast("Senha atualizada.");
      } catch (err) {
        console.error(err);
        const msg =
          err.code === "auth/requires-recent-login"
            ? "Por segurança, faça login novamente e tente mudar a senha de novo."
            : "Erro ao alterar senha.";
        if (status) status.textContent = msg;
        showToast(msg, "error");
      }
    });
  }
}

// helpers para HSL -> HEX
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
