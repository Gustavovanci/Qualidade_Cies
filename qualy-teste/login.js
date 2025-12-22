// login.js
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  ref,
  get,
  update
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const BRAND_COLORS = ['#276b38', '#e97b28', '#007AFF', '#5856D6', '#FF2D55', '#FF9500'];

function getSafeNextUrl() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return null;
  // Evita redirects externos
  if (/^https?:\/\//i.test(next)) return null;
  if (next.startsWith("//")) return null;
  // Força relativo
  return next.startsWith("/") ? next : next;
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

const form = document.getElementById("login-form");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    // garante que exista um registro em /users
    const user = cred.user;
    const snap = await get(ref(db, `users/${user.uid}`));
    if (!snap.exists()) {
      const name = email.split("@")[0];
      await update(ref(db, `users/${user.uid}`), {
        email,
        name,
        color: BRAND_COLORS[0]
      });
    }
    showToast("Bem-vindo(a) de volta!");
  } catch (err) {
    console.error(err);
    showToast("Falha no login: " + err.message, "error");
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    const next = getSafeNextUrl();
    window.location.href = next || "dashboard.html";
  }
});
