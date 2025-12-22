// dashboard.js (Kanban)
// Projeto: Qualy-Cies
// - Kanban para Qualidade / Segurança do Paciente
// - Lógica de atraso baseada em ONA (eventos) + prazos manuais (tarefas/projetos)

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  ref,
  onValue,
  get,
  push,
  update
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;
let profileData = null;
let eventsCache = {};

let searchTerm = "";
let severityFilter = "all";
let currentDetailId = null;
let canvasListenerAttached = false;

let pendingOpenId = new URLSearchParams(window.location.search).get("open");

const SEVERITY_LABELS = {
  grave: "Grave / óbito",
  obito: "Grave / óbito",
  moderado: "Moderado",
  leve: "Leve",
  sem_dano: "Evento sem dano",
  near_miss: "Near miss",
  nao_classificado: "Não classificado"
};

function $(id) {
  return document.getElementById(id);
}

function showToast(message, variant = "success") {
  const toast = $("toast");
  const msgEl = $("toast-message");
  if (!toast || !msgEl) return;

  msgEl.textContent = message;

  const icon = toast.querySelector(".toast-icon i");
  if (icon) {
    icon.className =
      variant === "error"
        ? "ph-bold ph-x-circle"
        : variant === "warning"
        ? "ph-bold ph-warning-circle"
        : "ph-bold ph-check-circle";
  }

  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2600);
}

function isValidISODate(dateStr) {
  return typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseISODate(dateStr) {
  if (!isValidISODate(dateStr)) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateBR(dateStr) {
  const d = parseISODate(dateStr);
  if (!d) return "-";
  return d.toLocaleDateString("pt-BR");
}

function formatDayMonthBR(dateStr) {
  const d = parseISODate(dateStr);
  if (!d) return "-";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

// --------------------------------------------------------------------------
// ONA / SLA (regras simplificadas)
// --------------------------------------------------------------------------

function getOnaConfig(severity) {
  // Observação: Ajuste fácil aqui se houver tabela oficial/local diferente.
  // A regra solicitada: 5 dias (grave/óbito), 10 dias (moderado), 10 dias (demais).
  if (severity === "grave" || severity === "obito") {
    return { daysLimit: 5, mandatory: true, label: "NOTIFICAÇÃO OBRIGATÓRIA" };
  }
  if (severity === "moderado") {
    return { daysLimit: 10, mandatory: true, label: "NOTIFICAÇÃO OBRIGATÓRIA" };
  }
  if (["leve", "sem_dano", "near_miss"].includes(severity)) {
    return { daysLimit: 10, mandatory: false, label: "Notificação recomendada" };
  }
  return {
    daysLimit: 10,
    mandatory: false,
    label: "Classificar gravidade (para regra ONA mais precisa)"
  };
}

function getOnaDeadline(severity, eventDateISO) {
  if (!eventDateISO) {
    return {
      deadlineISO: null,
      deadlineDate: null,
      date: "-",
      daysLeft: null,
      daysLimit: null,
      label: "Sem data base"
    };
  }

  const base = parseISODate(eventDateISO);
  if (!base) {
    return {
      deadlineISO: null,
      deadlineDate: null,
      date: "-",
      daysLeft: null,
      daysLimit: null,
      label: "Data inválida"
    };
  }

  const cfg = getOnaConfig(severity);
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + cfg.daysLimit);
  deadline.setHours(0, 0, 0, 0);

  const today = parseISODate(getTodayISO());
  const msDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil((deadline.getTime() - today.getTime()) / msDay);

  const deadlineISO = deadline.toISOString().slice(0, 10);
  return {
    deadlineISO,
    deadlineDate: deadline,
    date: deadline.toLocaleDateString("pt-BR"),
    daysLeft,
    daysLimit: cfg.daysLimit,
    label: cfg.label,
    mandatory: cfg.mandatory
  };
}

function getOverdueInfo(ev) {
  const status = ev?.status || "backlog";
  if (status === "done") {
    return { isOverdue: false, kind: null, dueISO: null, daysLeft: null };
  }

  const type = ev?.type || "evento";

  // 1) Evento: atraso pelo prazo ONA (baseado na data do evento)
  if (type === "evento" && ev?.date) {
    const ona = getOnaDeadline(ev.severity || "nao_classificado", ev.date);
    if (ona.deadlineISO) {
      return {
        isOverdue: typeof ona.daysLeft === "number" ? ona.daysLeft < 0 : false,
        kind: "ona",
        dueISO: ona.deadlineISO,
        daysLeft: ona.daysLeft,
        label: ona.label,
        ona
      };
    }
  }

  // 2) Fallback: prazo manual (tarefas/projetos ou evento sem data)
  if (ev?.deadline) {
    const due = parseISODate(ev.deadline);
    const today = parseISODate(getTodayISO());
    if (due && today) {
      const msDay = 1000 * 60 * 60 * 24;
      const daysLeft = Math.ceil((due.getTime() - today.getTime()) / msDay);
      return {
        isOverdue: daysLeft < 0,
        kind: "manual",
        dueISO: ev.deadline,
        daysLeft,
        label: "Prazo do card"
      };
    }
  }

  return { isOverdue: false, kind: null, dueISO: null, daysLeft: null };
}

function humanDTag(daysLeft) {
  if (typeof daysLeft !== "number") return "";
  if (daysLeft === 0) return "D-0";
  if (daysLeft > 0) return `D-${daysLeft}`;
  return `D+${Math.abs(daysLeft)}`;
}

// --------------------------------------------------------------------------
// AUTH
// --------------------------------------------------------------------------

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html?next=dashboard.html";
    return;
  }

  currentUser = user;

  const snap = await get(ref(db, `users/${user.uid}`));
  profileData =
    snap.val() || {
      email: user.email,
      name: user.email ? user.email.split("@")[0] : "Usuário",
      color: "#5856D6"
    };

  const name =
    profileData.name || (user.email ? user.email.split("@")[0] : "Usuário");
  const color = profileData.color || "#5856D6";

  const avatar = $("user-avatar");
  const nameSpan = $("user-name");
  if (avatar) {
    avatar.style.backgroundColor = color;
    avatar.textContent = (name[0] || "U").toUpperCase();
  }
  if (nameSpan) nameSpan.textContent = name;

  document.documentElement.style.setProperty("--accent", color);

  attachUIHandlers();
  listenEvents();
  listenCanvasSessions();
});

function attachUIHandlers() {
  const btnLogout = $("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      await signOut(auth);
    });
  }

  // Busca
  const toggleSearch = $("btn-toggle-search");
  const searchWrapper = $("search-wrapper");
  if (toggleSearch && searchWrapper) {
    toggleSearch.addEventListener("click", () => {
      searchWrapper.classList.toggle("collapsed");
      const input = $("search-input");
      if (!searchWrapper.classList.contains("collapsed") && input) {
        setTimeout(() => input.focus(), 120);
      }
    });
  }

  const searchInput = $("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchTerm = (e.target.value || "").toLowerCase();
      renderBoard();
    });
  }

  // Filtros de severidade
  const filters = document.querySelectorAll("#severity-filters .chip");
  filters.forEach((chip) => {
    chip.addEventListener("click", () => {
      filters.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      severityFilter = chip.dataset.filter || "all";
      renderBoard();
    });
  });

  // Modal: novo card
  const btnNewEvent = $("btn-new-event");
  if (btnNewEvent) {
    btnNewEvent.addEventListener("click", () => openNewCardModal());
  }

  const formNew = $("form-new-event");
  if (formNew) {
    formNew.addEventListener("submit", handleNewEvent);
  }

  const typeSel = $("new-type");
  if (typeSel) {
    typeSel.addEventListener("change", () => syncNewCardTypeUI());
  }

  // Modal: Canvas Hub
  const btnCanvas = $("btn-open-canvas");
  if (btnCanvas) {
    btnCanvas.addEventListener("click", () => openModal("modal-canvas-hub"));
  }

  const formCanvas = $("form-new-canvas");
  if (formCanvas) {
    formCanvas.addEventListener("submit", handleNewCanvas);
  }

  // Indicadores
  const toggleIndicators = $("toggle-indicators");
  if (toggleIndicators) {
    toggleIndicators.addEventListener("click", () => {
      const panel = $("indicators-panel");
      const label = $("toggle-indicators-label");
      if (!panel || !label) return;

      panel.classList.toggle("collapsed");
      label.textContent = panel.classList.contains("collapsed")
        ? "Mostrar indicadores"
        : "Ocultar indicadores";
    });
  }

  // Mantém a coluna "Atrasado" atualizada mesmo se o usuário
  // deixar a tela aberta até virar o dia.
  scheduleMidnightRefresh();
}

let midnightTimer = null;
function scheduleMidnightRefresh() {
  if (midnightTimer) return; // evita múltiplos timers

  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 5, 0); // 00:00:05 do dia seguinte
  const ms = Math.max(10_000, next.getTime() - now.getTime());

  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    renderBoard();
    renderIndicators();
    scheduleMidnightRefresh();
  }, ms);
}

function syncNewCardTypeUI() {
  const type = $("new-type")?.value || "evento";
  const onlyEvent = $("new-event-only");
  const sev = $("new-severity");

  const isEvent = type === "evento";
  if (onlyEvent) onlyEvent.classList.toggle("hidden", !isEvent);
  if (sev) sev.disabled = !isEvent;
}

function openNewCardModal() {
  const form = $("form-new-event");
  if (form) form.reset();

  // defaults
  const today = getTodayISO();
  const type = $("new-type");
  if (type) type.value = "evento";
  const date = $("new-date");
  if (date) date.value = today;
  const notify = $("new-notification-date");
  if (notify) notify.value = today;

  syncNewCardTypeUI();
  openModal("modal-new-event");
}

// --------------------------------------------------------------------------
// CRUD
// --------------------------------------------------------------------------

async function handleNewEvent(e) {
  e.preventDefault();
  if (!currentUser) return;

  const title = $("new-title")?.value?.trim();
  if (!title) {
    showToast("Informe um título para o card.", "warning");
    return;
  }

  const type = $("new-type")?.value || "evento";
  const isEvent = type === "evento";

  const payload = {
    title,
    desc: $("new-desc")?.value?.trim() || "",
    type,
    severity: isEvent ? $("new-severity")?.value || "nao_classificado" : "nao_classificado",
    date: $("new-date")?.value || null,
    deadline: $("new-deadline")?.value || null,
    unit: $("new-unit")?.value?.trim() || "",
    qualityRelated: $("new-quality-related")?.value === "sim",
    status: "backlog",
    createdByUid: currentUser.uid,
    createdBy: currentUser.email,
    createdByName:
      profileData?.name || (currentUser.email ? currentUser.email.split("@")[0] : ""),
    ownerColor: profileData?.color || "#5856D6",
    createdAt: new Date().toISOString()
  };

  if (isEvent) {
    const eventCode = $("new-event-code")?.value?.trim();
    const notificationDate = $("new-notification-date")?.value || getTodayISO();
    const patientName = $("new-patient-name")?.value?.trim();
    const patientDob = $("new-patient-dob")?.value || null;

    if (eventCode) payload.eventCode = eventCode;
    if (notificationDate) payload.notificationDate = notificationDate;
    if (patientName) payload.patientName = patientName;
    if (patientDob) payload.patientDob = patientDob;
    payload.notificationSystem = payload.notificationSystem || "Docnix";
  }

  await push(ref(db, "events"), payload);

  $("form-new-event")?.reset();
  closeModal("modal-new-event");
  showToast("Card criado.");
}

function listenEvents() {
  onValue(ref(db, "events"), (snap) => {
    eventsCache = snap.val() || {};
    renderBoard();
    renderIndicators();
    tryOpenFromQuery();
  });
}

function tryOpenFromQuery() {
  if (!pendingOpenId) return;
  const ev = eventsCache?.[pendingOpenId];
  if (!ev) return;

  // Não abre arquivado por padrão (mas o usuário pode abrir no Arquivos)
  if (ev.archived) {
    showToast("Este card está arquivado. Consulte em Arquivos.", "warning");
    pendingOpenId = null;
    cleanupOpenParam();
    return;
  }

  openDetail(pendingOpenId);
  pendingOpenId = null;
  cleanupOpenParam();
}

function cleanupOpenParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("open");
    window.history.replaceState({}, "", url.toString());
  } catch {
    // ignore
  }
}

// --------------------------------------------------------------------------
// Canvas (sessões avulsas)
// --------------------------------------------------------------------------

function listenCanvasSessions() {
  if (canvasListenerAttached) return;
  canvasListenerAttached = true;

  const listEl = $("canvas-list");
  if (!listEl) return;

  onValue(ref(db, "toolSessions"), (snap) => {
    const data = snap.val() || {};
    listEl.innerHTML = "";

    const entries = Object.entries(data).sort(
      (a, b) => new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0)
    );

    if (!entries.length) {
      listEl.innerHTML =
        '<p style="font-size:12px;color:var(--text-secondary);">Nenhum canvas criado ainda.</p>';
      return;
    }

    entries.forEach(([id, item]) => {
      const row = document.createElement("div");
      row.className = "archive-item";

      const toolLabel =
        {
          ishikawa: "Ishikawa",
          "w2h": "5W2H",
          "5w2h": "5W2H", // compat (dados antigos)
          pdca: "PDCA",
          fmea: "FMEA / HFMEA",
          notes: "Canvas de notas"
        }[item.toolType] || "Ferramenta";

      row.innerHTML = `
        <div class="archive-title">${item.title || "Sem título"}</div>
        <div class="archive-meta">
          ${toolLabel} • Criado em ${
        item.createdAt ? new Date(item.createdAt).toLocaleDateString("pt-BR") : "-"
      } por ${(item.createdByName || item.createdBy || "").split("@")[0]}
        </div>
        <div class="archive-actions">
          <button type="button" data-id="${id}" class="btn-secondary small">Abrir</button>
        </div>
      `;

      const btn = row.querySelector("button");
      btn.addEventListener("click", () => {
        window.open(
          `tools.html?sessionId=${id}&tool=${item.toolType || "ishikawa"}`,
          "_blank"
        );
      });

      listEl.appendChild(row);
    });
  });
}

async function handleNewCanvas(e) {
  e.preventDefault();
  if (!currentUser) return;

  const title = $("canvas-title")?.value?.trim();
  const tool = $("canvas-tool")?.value || "ishikawa";
  if (!title) {
    showToast("Informe um título para o canvas.", "warning");
    return;
  }

  const color = profileData?.color || "#5856D6";

  const newRef = await push(ref(db, "toolSessions"), {
    title,
    toolType: tool,
    createdByUid: currentUser.uid,
    createdBy: currentUser.email,
    createdByName:
      profileData?.name || (currentUser.email ? currentUser.email.split("@")[0] : ""),
    color,
    createdAt: new Date().toISOString()
  });

  $("form-new-canvas")?.reset();
  closeModal("modal-canvas-hub");
  window.open(`tools.html?sessionId=${newRef.key}&tool=${tool}`, "_blank");
}

// --------------------------------------------------------------------------
// Kanban
// --------------------------------------------------------------------------

function renderBoard() {
  const cols = ["backlog", "doing", "late", "done"];
  cols.forEach((status) => {
    const list = $(
      `list-${status}`
    );
    const count = $(
      `count-${status}`
    );
    if (list) list.innerHTML = "";
    if (count) count.textContent = "0";
  });

  const today = parseISODate(getTodayISO());

  Object.entries(eventsCache).forEach(([id, ev]) => {
    if (!ev) return;
    if (ev.archived) return;

    const type = ev.type || "evento";
    const statusOrig = ev.status || "backlog";

    // Filtro de severidade (aplica a eventos; quando filtro != all, esconde cards não-evento)
    const sev = ev.severity || "nao_classificado";
    if (severityFilter !== "all" && type !== "evento") {
      return;
    }
    if (type === "evento") {
      if (severityFilter === "grave") {
        if (!(sev === "grave" || sev === "obito")) return;
      } else if (severityFilter === "moderado") {
        if (sev !== "moderado") return;
      } else if (severityFilter === "leve") {
        if (!["leve", "sem_dano", "near_miss"].includes(sev)) return;
      }
    }

    // Filtro de busca
    if (searchTerm) {
      const blob = (
        (ev.title || "") +
        " " +
        (ev.desc || "") +
        " " +
        (ev.unit || "") +
        " " +
        (ev.createdBy || "") +
        " " +
        (ev.eventCode || "")
      ).toLowerCase();
      if (!blob.includes(searchTerm)) return;
    }

    const overdue = getOverdueInfo(ev);

    // Regra: se está atrasado e não está concluído, vai para "late" automaticamente.
    // Importante: não reverte automaticamente do late para outro status.
    let status = statusOrig;
    if (statusOrig !== "done" && overdue.isOverdue) {
      status = "late";
      if (statusOrig !== "late") {
        update(ref(db, `events/${id}`), { status: "late" }).catch(() => {});
      }
    }

    const col = $(
      `list-${status}`
    );
    if (!col) return;

    const card = createCardElement(id, ev);
    col.appendChild(card);

    const count = $(
      `count-${status}`
    );
    if (count) count.textContent = String(parseInt(count.textContent || "0", 10) + 1);
  });
}

function createCardElement(id, ev) {
  const div = document.createElement("div");
  div.className = "k-card";
  div.draggable = true;
  div.dataset.id = id;

  div.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", id);
  });

  div.addEventListener("click", () => openDetail(id));

  const type = ev.type || "evento";
  const typeLabel =
    type === "tarefa" ? "Tarefa" : type === "projeto" ? "Projeto" : "Evento";

  const severity = ev.severity || "nao_classificado";
  const sevLabel = SEVERITY_LABELS[severity] || severity;
  const sevClass =
    severity === "grave" || severity === "obito"
      ? "severity-grave"
      : severity === "moderado"
      ? "severity-moderado"
      : ["leve", "sem_dano", "near_miss"].includes(severity)
      ? "severity-leve"
      : "severity-default";

  // Prazo visível no card
  let dueText = "-";
  let dueClass = "";
  let dueTitle = "";

  const overdue = getOverdueInfo(ev);
  if (type === "evento" && ev.date) {
    const ona = getOnaDeadline(severity, ev.date);
    if (ona.deadlineISO) {
      const tag = humanDTag(ona.daysLeft);
      dueText = `ONA ${formatDayMonthBR(ona.deadlineISO)}${tag ? ` (${tag})` : ""}`;
      dueTitle = `${ona.label} • Prazo ONA até ${ona.date}${
        typeof ona.daysLeft === "number" ? ` (${ona.daysLeft} dias)` : ""
      }`;
      if (typeof ona.daysLeft === "number") {
        if (ona.daysLeft < 0) dueClass = "over";
        else if (ona.daysLeft <= 2) dueClass = "soon";
      }
    } else {
      dueText = "ONA -";
      dueTitle = "Preencha a data do evento para calcular o prazo ONA.";
    }
  } else if (ev.deadline) {
    dueText = formatDateBR(ev.deadline);
    dueTitle = `Prazo do card: ${formatDateBR(ev.deadline)}`;

    if (overdue.kind === "manual" && typeof overdue.daysLeft === "number") {
      if (overdue.daysLeft < 0) dueClass = "over";
      else if (overdue.daysLeft <= 2) dueClass = "soon";
    }
  }

  const tools = ev.toolsUsed || {};
  // Evita duplicidade (compatibilidade com dados antigos)
  const toolSet = new Set();
  if (tools.ishikawa) toolSet.add("Ishikawa");
  if (tools.w2h || tools["5w2h"]) toolSet.add("5W2H");
  if (tools.pdca) toolSet.add("PDCA");
  if (tools.fmea) toolSet.add("FMEA");
  if (tools.notes) toolSet.add("Notas");
  if (tools.londres) toolSet.add("Londres");
  const toolPills = Array.from(toolSet);

  const ownerInitial = (ev.createdByName || ev.createdBy || "?")[0]?.toUpperCase() || "?";
  const ownerColor = ev.ownerColor || profileData?.color || "#5856D6";

  const extraTags = [];
  if (type === "evento" && ev.eventCode) {
    extraTags.push(`<span class="card-type-tag">Nº ${ev.eventCode}</span>`);
  }
  if (ev.unit) {
    extraTags.push(`<span class="card-type-tag">${ev.unit}</span>`);
  }

  div.innerHTML = `
    <div class="card-topline">
      <div>
        <div class="card-title">${ev.title || "Sem título"}</div>
        <div class="card-badges">
          ${
            type === "evento"
              ? `<span class="card-badge ${sevClass}">${sevLabel}</span>`
              : ""
          }
          <span class="card-type-tag">${typeLabel}</span>
          ${extraTags.join("")}
        </div>
      </div>
    </div>
    <div class="card-middle">
      ${(ev.desc || "").slice(0, 110)}${ev.desc && ev.desc.length > 110 ? "..." : ""}
    </div>
    <div class="card-footer">
      <div class="card-tools">
        ${toolPills.map((t) => `<span class="tool-pill">${t}</span>`).join("")}
      </div>
      <div class="card-meta">
        <span class="card-due ${dueClass}" title="${(dueTitle || "").replaceAll("\"", "&quot;")}">
          ${dueText}
        </span>
        <span class="card-owner-dot" style="background:${ownerColor}">${ownerInitial}</span>
      </div>
    </div>
  `;

  return div;
}

// --------------------------------------------------------------------------
// Drag & Drop globais
// --------------------------------------------------------------------------

window.allowDrop = (ev) => {
  ev.preventDefault();
};

window.drop = (ev) => {
  ev.preventDefault();
  let target = ev.target;
  while (target && !target.dataset?.status && !target.id?.startsWith("col-")) {
    target = target.parentElement;
  }
  if (!target) return;

  const status = target.dataset.status || target.id.replace("col-", "") || "backlog";
  const id = ev.dataTransfer.getData("text/plain");
  if (!id) return;

  const card = eventsCache?.[id];
  if (!card) return;

  const overdue = getOverdueInfo(card);
  if (overdue.isOverdue && status !== "done" && status !== "late") {
    showToast(
      "Este card está em atraso. Ajuste a data/gravidade/prazo ou marque como concluído.",
      "warning"
    );
    // Força permanecer em late
    update(ref(db, `events/${id}`), { status: "late" }).catch(() => {});
    return;
  }

  update(ref(db, `events/${id}`), { status }).catch(() => {});
};

// --------------------------------------------------------------------------
// Modais globais (precisam ser globais por causa do onclick)
// --------------------------------------------------------------------------

function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove("hidden");
}

function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add("hidden");
}

window.openModal = openModal;
window.closeModal = closeModal;

// --------------------------------------------------------------------------
// Detalhe do card (inclui sequência PCT para eventos)
// --------------------------------------------------------------------------

function openDetail(id) {
  const ev = eventsCache?.[id];
  if (!ev) return;

  currentDetailId = id;
  const type = ev.type || "evento";
  const isEvent = type === "evento";

  // Título editável (contenteditable)
  const titleEl = $("detail-title");
  const originalTitle = ev.title || "Sem título";
  if (titleEl) {
    titleEl.textContent = originalTitle;
    titleEl.onblur = () => {
      const next = (titleEl.textContent || "").trim();
      if (!next) {
        titleEl.textContent = originalTitle;
        showToast("O título não pode ficar vazio.", "warning");
        return;
      }
      if (next !== (eventsCache?.[id]?.title || "")) {
        update(ref(db, `events/${id}`), { title: next }).catch(() => {
          showToast("Erro ao salvar o título.", "error");
        });
      }
    };
  }

  // Resumo
  const descEl = $("detail-desc");
  if (descEl) {
    descEl.value = ev.desc || "";
  }

  const btnSaveSummary = $("btn-save-summary");
  if (btnSaveSummary) {
    btnSaveSummary.onclick = () => {
      const nextDesc = (descEl?.value || "").trim();
      update(ref(db, `events/${id}`), { desc: nextDesc }).then(() => {
        showToast("Resumo salvo.");
      }).catch(() => {
        showToast("Erro ao salvar o resumo.", "error");
      });
    };
  }

  // Datas & status (texto)
  const parts = [];
  parts.push(`Tipo: ${type}`);
  if (ev.unit) parts.push(`Unidade: ${ev.unit}`);
  if (ev.date) parts.push(`Data: ${formatDateBR(ev.date)}`);
  if (ev.deadline) parts.push(`Prazo: ${formatDateBR(ev.deadline)}`);
  if (ev.eventCode) parts.push(`Nº: ${ev.eventCode}`);

  const datesEl = $("detail-dates");
  if (datesEl) datesEl.textContent = parts.join(" • ");

  const onaEl = $("detail-ona");
  if (onaEl) {
    if (isEvent) {
      const ona = getOnaDeadline(ev.severity || "nao_classificado", ev.date);
      if (ona.deadlineISO) {
        const tag = typeof ona.daysLeft === "number" ? humanDTag(ona.daysLeft) : "";
        const statusTxt = ona.daysLeft < 0 ? "ATRASADO" : "Dentro do prazo";
        onaEl.textContent = `Insight ONA: ${ona.label} • Prazo até ${ona.date} ${tag ? `(${tag})` : ""} • ${statusTxt}.`;
      } else {
        onaEl.textContent = "Insight ONA: preencha a data do evento para calcular o prazo.";
      }
    } else {
      const overdue = getOverdueInfo(ev);
      if (overdue.kind === "manual" && overdue.dueISO) {
        const tag = humanDTag(overdue.daysLeft);
        onaEl.textContent = `Prazo do card: ${formatDateBR(overdue.dueISO)} ${tag ? `(${tag})` : ""}.`;
      } else {
        onaEl.textContent = "";
      }
    }
  }

  // PCT container (apenas evento)
  const pct = $("pct-container");
  if (pct) pct.classList.toggle("hidden", !isEvent);

  // Preenche campos PCT (e permite edição)
  let pctSnapshot = null;
  if (isEvent) {
    pctSnapshot = {
      patientName: ev.patientName || "",
      patientDob: ev.patientDob || "",
      eventCode: ev.eventCode || "",
      date: ev.date || "",
      notificationDate: ev.notificationDate || (ev.createdAt ? ev.createdAt.slice(0, 10) : ""),
      unit: ev.unit || "",
      notificationSystem: ev.notificationSystem || "Docnix",
      notificationText: ev.notificationText || "",
      chronology: ev.chronologyText || "",
      outcome: ev.outcomeText || "",
      interview: ev.interviewText || "",
      investigationTeam: ev.investigationTeam || "",
      conclusion: ev.conclusionText || ""
    };

    const setVal = (idEl, val) => {
      const el = $(idEl);
      if (!el) return;
      if ("value" in el) el.value = val || "";
    };

    setVal("pct-patient-name", pctSnapshot.patientName);
    setVal("pct-patient-dob", pctSnapshot.patientDob);
    setVal("pct-event-code", pctSnapshot.eventCode);
    setVal("pct-event-date", pctSnapshot.date);
    setVal("pct-notification-date", pctSnapshot.notificationDate);
    setVal("pct-unit", pctSnapshot.unit);
    setVal("pct-notification-system", pctSnapshot.notificationSystem);
    setVal("pct-notification-text", pctSnapshot.notificationText);
    setVal("pct-chronology", pctSnapshot.chronology);
    setVal("pct-outcome", pctSnapshot.outcome);
    setVal("pct-interview", pctSnapshot.interview);
    setVal("pct-investigation-team", pctSnapshot.investigationTeam);
    setVal("pct-conclusion", pctSnapshot.conclusion);

    const btnRevert = $("btn-pct-revert");
    if (btnRevert) {
      btnRevert.onclick = () => {
        setVal("pct-patient-name", pctSnapshot.patientName);
        setVal("pct-patient-dob", pctSnapshot.patientDob);
        setVal("pct-event-code", pctSnapshot.eventCode);
        setVal("pct-event-date", pctSnapshot.date);
        setVal("pct-notification-date", pctSnapshot.notificationDate);
        setVal("pct-unit", pctSnapshot.unit);
        setVal("pct-notification-system", pctSnapshot.notificationSystem);
        setVal("pct-notification-text", pctSnapshot.notificationText);
        setVal("pct-chronology", pctSnapshot.chronology);
        setVal("pct-outcome", pctSnapshot.outcome);
        setVal("pct-interview", pctSnapshot.interview);
        setVal("pct-investigation-team", pctSnapshot.investigationTeam);
        setVal("pct-conclusion", pctSnapshot.conclusion);
        const status = $("pct-save-status");
        if (status) status.textContent = "Alterações revertidas (não salvas).";
      };
    }

    const btnSave = $("btn-pct-save");
    if (btnSave) {
      btnSave.onclick = () => savePct(id);
    }
  }

  // Ferramentas
  const toolsUsed = ev.toolsUsed || {};
  const container = $("detail-tools-badges");
  if (container) {
    container.innerHTML = "";
    const labels = {
      ishikawa: "Ishikawa",
      w2h: "5W2H",
      pdca: "PDCA",
      londres: "Londres",
      fmea: "FMEA"
    };
    Object.entries(labels).forEach(([key, label]) => {
      if (toolsUsed[key]) {
        const span = document.createElement("span");
        span.className = "tool-pill";
        span.textContent = label.toUpperCase();
        container.appendChild(span);
      }
    });
  }

  // Abertura das ferramentas em nova aba
  const openTool = (tool) => {
    window.open(`tools.html?eventId=${id}&tool=${tool}`, "_blank");
  };

  $("btn-open-ishikawa").onclick = () => openTool("ishikawa");
  $("btn-open-5w2h").onclick = () => openTool("5w2h");
  $("btn-open-pdca").onclick = () => openTool("pdca");
  $("btn-open-fmea").onclick = () => openTool("fmea");
  $("btn-open-notes").onclick = () => openTool("notes");

  // Botões inline dentro do PCT
  const b5 = $("btn-open-5w2h-inline");
  if (b5) b5.onclick = () => openTool("5w2h");
  const bf = $("btn-open-fmea-inline");
  if (bf) bf.onclick = () => openTool("fmea");

  // Ações rápidas
  const btnMoveDoing = $("btn-move-doing");
  if (btnMoveDoing) {
    btnMoveDoing.onclick = () => {
      const overdue = getOverdueInfo(eventsCache?.[id]);
      if (overdue.isOverdue) {
        showToast(
          "Card em atraso: ajuste data/gravidade/prazo ou marque como concluído.",
          "warning"
        );
        return;
      }
      update(ref(db, `events/${id}`), { status: "doing" }).catch(() => {});
      showToast("Movido para em tratativa.");
    };
  }

  const btnMoveDone = $("btn-move-done");
  if (btnMoveDone) {
    btnMoveDone.onclick = () => {
      update(ref(db, `events/${id}`), { status: "done" }).catch(() => {});
      showToast("Marcado como concluído.");
    };
  }

  const btnArchive = $("btn-archive");
  if (btnArchive) {
    btnArchive.onclick = () => archiveEvent(id);
  }

  openModal("modal-detail");
}

async function savePct(id) {
  const ev = eventsCache?.[id];
  if (!ev) return;

  const getVal = (elId) => {
    const el = $(elId);
    if (!el) return "";
    return (el.value || "").trim();
  };

  const updates = {
    patientName: getVal("pct-patient-name"),
    patientDob: $("pct-patient-dob")?.value || null,
    eventCode: getVal("pct-event-code"),
    date: $("pct-event-date")?.value || null,
    notificationDate: $("pct-notification-date")?.value || null,
    unit: getVal("pct-unit"),
    notificationSystem: getVal("pct-notification-system") || "Docnix",
    notificationText: getVal("pct-notification-text"),
    chronologyText: getVal("pct-chronology"),
    outcomeText: getVal("pct-outcome"),
    interviewText: getVal("pct-interview"),
    investigationTeam: getVal("pct-investigation-team"),
    conclusionText: getVal("pct-conclusion")
  };

  // Normaliza vazios
  Object.keys(updates).forEach((k) => {
    if (updates[k] === "") updates[k] = null;
  });

  try {
    await update(ref(db, `events/${id}`), updates);
    const status = $("pct-save-status");
    if (status) {
      status.textContent = `PCT salvo em ${new Date().toLocaleString("pt-BR")}.`;
    }
    showToast("PCT salvo.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao salvar o PCT.", "error");
  }
}

async function archiveEvent(id) {
  const ev = eventsCache?.[id];
  if (!ev) return;

  try {
    await update(ref(db, `events/${id}`), {
      archived: true,
      status: "done",
      archivedAt: new Date().toISOString(),
      archivedByUid: currentUser?.uid || null,
      archivedBy: currentUser?.email || null
    });
    closeModal("modal-detail");
    showToast("Análise arquivada.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao arquivar.", "error");
  }
}

// --------------------------------------------------------------------------
// Indicadores
// --------------------------------------------------------------------------

function renderIndicators() {
  let open = 0;
  let todayCount = 0;
  let onaInside = 0;
  let onaLate = 0;
  let complete = 0;

  const todayStr = getTodayISO();

  Object.values(eventsCache).forEach((ev) => {
    if (!ev) return;
    if (ev.archived) {
      // Completo (arquivado) também conta
      const tools = ev.toolsUsed || {};
      if (tools.ishikawa && tools.pdca) complete++;
      return;
    }

    if (ev.status !== "done") open++;

    if (ev.date && ev.date === todayStr) todayCount++;

    if (ev.type === "evento" && ev.status !== "done") {
      const ona = getOnaDeadline(ev.severity, ev.date);
      if (typeof ona.daysLeft === "number") {
        if (ona.daysLeft >= 0) onaInside++;
        else onaLate++;
      }
    }

    const tools = ev.toolsUsed || {};
    if (ev.status === "done" && tools.ishikawa && tools.pdca) {
      complete++;
    }
  });

  $("ind-open").textContent = String(open);
  $("ind-today").textContent = String(todayCount);
  $("ind-ona").textContent = String(onaInside);
  $("ind-ona-detail").textContent = `${onaInside} dentro / ${onaLate} vencidos`;
  $("ind-complete").textContent = String(complete);
}
