// calendar.js
// - Visão Mês (estilo Google Calendar) + Visão Agenda
// - Mostra:
//   1) Cards do Kanban (data)
//   2) Prazos (ONA p/ eventos + prazo manual)
//   3) Eventos de calendário (agenda)

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, onValue, get, push } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;
let profileData = null;

let currentMonth = new Date();
currentMonth.setDate(1);

let viewMode = "month"; // 'month' | 'agenda'
let selectedDateISO = getTodayISO();

let kanbanCache = {};
let calendarCache = {};

let itemsByDate = {}; // { 'YYYY-MM-DD': [items...] }

// --------------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function showToast(message, variant = "success") {
  const toast = $("toast");
  const msgEl = $("toast-message");
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

function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove("hidden");
}

function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add("hidden");
}

window.closeModal = closeModal;

function getTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseISODate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateBR(iso) {
  const d = parseISODate(iso);
  if (!d) return "-";
  return d.toLocaleDateString("pt-BR");
}

function formatDayMonthBR(iso) {
  const d = parseISODate(iso);
  if (!d) return "-";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function severityColor(sev) {
  if (sev === "grave" || sev === "obito") return "#FF3B30"; // danger
  if (sev === "moderado") return "#FF9500"; // warning
  if (["leve", "sem_dano", "near_miss"].includes(sev)) return "#34C759"; // success
  return "#5D5D6D"; // neutro
}

function kindColor(kind, item) {
  // Cards e prazos usam cor pela gravidade (eventos). Agenda usa cor do perfil.
  if (kind === "calendar") return profileData?.color || "#5856D6";
  if (item?.type === "evento") return severityColor(item?.severity || "nao_classificado");
  return profileData?.color || "#5856D6";
}

function getOnaConfig(severity) {
  switch (severity) {
    case "obito":
    case "grave":
      return { daysLimit: 5, label: "Notificação ONA em até 5 dias" };
    case "moderado":
      return { daysLimit: 10, label: "Notificação ONA em até 10 dias" };
    case "leve":
    case "sem_dano":
    case "near_miss":
      return { daysLimit: 10, label: "Notificação recomendada (10 dias)" };
    default:
      return { daysLimit: 10, label: "Classificar gravidade (padrão 10 dias)" };
  }
}

function getOnaDeadline(severity, eventDateStr) {
  const base = parseISODate(eventDateStr);
  if (!base) return { deadlineISO: null, daysLeft: null, label: "" };

  const { daysLimit, label } = getOnaConfig(severity);
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + daysLimit);

  const deadlineISO = deadline.toISOString().slice(0, 10);
  const today = parseISODate(getTodayISO());
  const msDay = 24 * 60 * 60 * 1000;
  const daysLeft = Math.ceil((deadline - today) / msDay);

  return {
    deadlineISO,
    daysLeft,
    label,
    daysLimit
  };
}

function setAccentColor(color) {
  if (!color) return;
  document.documentElement.style.setProperty("--accent", color);
}

// --------------------------------------------------------------------------
// Auth + Perfil
// --------------------------------------------------------------------------

$("btn-logout")?.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html?next=calendar.html";
    return;
  }

  currentUser = { uid: user.uid, email: user.email };

  await loadProfile(user.uid, user.email);
  bindUI();
  subscribeData();
});

async function loadProfile(uid, email) {
  try {
    const snap = await get(ref(db, `users/${uid}`));
    profileData = snap.exists() ? snap.val() : null;
  } catch {
    profileData = null;
  }

  const avatar = $("user-avatar");
  const userNameSpan = $("user-name");

  const name = profileData?.name || (email ? email.split("@")[0] : "Usuário");
  const initial = (name || "?")[0]?.toUpperCase() || "?";
  if (avatar) avatar.textContent = initial;
  if (userNameSpan) userNameSpan.textContent = name;

  if (profileData?.color) setAccentColor(profileData.color);
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

function bindUI() {
  $("btn-prev-month")?.addEventListener("click", () => {
    currentMonth.setMonth(currentMonth.getMonth() - 1);
    renderAll();
  });

  $("btn-next-month")?.addEventListener("click", () => {
    currentMonth.setMonth(currentMonth.getMonth() + 1);
    renderAll();
  });

  $("btn-today")?.addEventListener("click", () => {
    const t = new Date();
    t.setDate(1);
    currentMonth = t;
    selectedDateISO = getTodayISO();
    renderAll();
  });

  $("btn-view-month")?.addEventListener("click", () => {
    viewMode = "month";
    setViewButtons();
    renderAll();
  });

  $("btn-view-agenda")?.addEventListener("click", () => {
    viewMode = "agenda";
    setViewButtons();
    renderAll();
  });

  $("btn-new-calendar-event")?.addEventListener("click", () => {
    prefillCalendarForm(selectedDateISO || getTodayISO());
    openModal("modal-calendar");
  });

  $("calendar-event-form")?.addEventListener("submit", handleCalendarFormSubmit);

  $("day-modal-new")?.addEventListener("click", () => {
    prefillCalendarForm(selectedDateISO || getTodayISO());
    closeModal("modal-day");
    openModal("modal-calendar");
  });

  setViewButtons();
  renderAll();
}

function setViewButtons() {
  const btnMonth = $("btn-view-month");
  const btnAgenda = $("btn-view-agenda");
  if (btnMonth) btnMonth.classList.toggle("active", viewMode === "month");
  if (btnAgenda) btnAgenda.classList.toggle("active", viewMode === "agenda");

  $("month-view")?.classList.toggle("hidden", viewMode !== "month");
  $("agenda-view")?.classList.toggle("hidden", viewMode !== "agenda");
}

function prefillCalendarForm(iso) {
  const dateInput = $("cal-date");
  if (dateInput) dateInput.value = iso || getTodayISO();
}

// --------------------------------------------------------------------------
// Data subscriptions
// --------------------------------------------------------------------------

function subscribeData() {
  // Kanban cards
  onValue(ref(db, "events"), (snap) => {
    kanbanCache = snap.val() || {};
    rebuildItems();
    renderAll();
  });

  // Calendar events
  onValue(ref(db, "calendarEvents"), (snap) => {
    calendarCache = snap.val() || {};
    rebuildItems();
    renderAll();
  });
}

function rebuildItems() {
  itemsByDate = {};

  // 1) Kanban
  Object.entries(kanbanCache).forEach(([id, card]) => {
    if (!card || card.archived) return;

    const type = card.type || "evento";
    const severity = card.severity || "nao_classificado";

    // Data do card (início / data do evento)
    if (card.date) {
      addItem(card.date, {
        kind: "card",
        id,
        title: card.title || "Card",
        type,
        severity,
        unit: card.unit || "",
        status: card.status || "backlog",
        meta: type === "evento" ? "Evento" : type === "tarefa" ? "Tarefa" : "Projeto"
      });
    }

    // Prazo ONA (somente eventos)
    if (type === "evento" && card.date) {
      const ona = getOnaDeadline(severity, card.date);
      if (ona.deadlineISO) {
        addItem(ona.deadlineISO, {
          kind: "deadline",
          id,
          title: `Prazo ONA — ${card.title || "Card"}`,
          type,
          severity,
          unit: card.unit || "",
          status: card.status || "backlog",
          meta: ona.label
        });
      }
    }

    // Prazo manual (tarefas/projetos e opcional)
    if (card.deadline) {
      addItem(card.deadline, {
        kind: "deadline",
        id,
        title: `Prazo — ${card.title || "Card"}`,
        type,
        severity,
        unit: card.unit || "",
        status: card.status || "backlog",
        meta: "Prazo manual"
      });
    }
  });

  // 2) Agenda
  const email = (currentUser?.email || "").toLowerCase();
  Object.entries(calendarCache).forEach(([id, ev]) => {
    if (!ev || !ev.date) return;

    // Filtra por participante quando existir, senão exibe se foi criado pelo usuário
    if (ev.attendees && email) {
      if (!ev.attendees[email]) return;
    } else if (ev.createdBy && email) {
      if (String(ev.createdBy).toLowerCase() !== email) return;
    }

    addItem(ev.date, {
      kind: "calendar",
      id,
      title: ev.title || "Evento",
      startTime: ev.startTime || null,
      endTime: ev.endTime || null,
      description: ev.description || "",
      meta: ev.startTime ? `${ev.startTime.slice(0, 5)}${ev.endTime ? `–${ev.endTime.slice(0, 5)}` : ""}` : ""
    });
  });

  // Ordena itens por horário (agenda) / por tipo
  Object.keys(itemsByDate).forEach((iso) => {
    itemsByDate[iso].sort((a, b) => {
      // Agenda com hora primeiro
      const at = a.kind === "calendar" ? (a.startTime || "") : "";
      const bt = b.kind === "calendar" ? (b.startTime || "") : "";
      if (at !== bt) return at.localeCompare(bt);

      // Card antes do prazo (para leitura)
      const prio = (x) => (x.kind === "card" ? 0 : x.kind === "deadline" ? 1 : 2);
      return prio(a) - prio(b);
    });
  });
}

function addItem(iso, item) {
  if (!iso) return;
  if (!itemsByDate[iso]) itemsByDate[iso] = [];
  itemsByDate[iso].push(item);
}

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------

function renderAll() {
  renderMonthLabel();
  renderMonthGrid();
  renderSidebar();
  renderAgendaView();
}

function renderMonthLabel() {
  const monthLabel = $("calendar-month-label");
  if (!monthLabel) return;

  const formatter = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric"
  });
  monthLabel.textContent = formatter.format(currentMonth);
}

function renderMonthGrid() {
  const grid = $("calendar-grid");
  if (!grid) return;

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay(); // 0..6 (Dom..Sáb)
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - startDay);

  grid.innerHTML = "";

  const todayISO = getTodayISO();
  const totalCells = 42; // 6 semanas

  for (let i = 0; i < totalCells; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    date.setHours(0, 0, 0, 0);

    const iso = date.toISOString().slice(0, 10);
    const inCurrentMonth = date.getMonth() === month;

    const day = document.createElement("div");
    day.className = "calendar-day";
    if (!inCurrentMonth) day.classList.add("other");
    if (iso === todayISO) day.classList.add("today");
    if (iso === selectedDateISO) day.classList.add("selected");

    const header = document.createElement("div");
    header.className = "calendar-day-header";

    const num = document.createElement("div");
    num.className = "calendar-day-number";
    num.textContent = String(date.getDate());
    header.appendChild(num);
    day.appendChild(header);

    const list = document.createElement("div");
    list.className = "calendar-events";

    const dayItems = itemsByDate[iso] || [];
    const maxVisible = 3;
    const visible = dayItems.slice(0, maxVisible);
    const hiddenCount = dayItems.length - visible.length;

    visible.forEach((item) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "calendar-event-pill";

      const bg = kindColor(item.kind, item);
      pill.style.background = bg;
      pill.style.opacity = item.status === "done" ? "0.55" : "1";

      const prefix =
        item.kind === "deadline" ? "⏳ " : item.kind === "calendar" ? "📅 " : "";
      const time = item.kind === "calendar" && item.startTime ? `${item.startTime.slice(0, 5)} ` : "";
      pill.textContent = `${prefix}${time}${item.title}`;
      pill.title = item.meta || "";

      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedDateISO = iso;
        renderSidebar();
        openDayModal(iso);
      });

      list.appendChild(pill);
    });

    if (hiddenCount > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "calendar-more-btn";
      more.textContent = `+${hiddenCount} mais`;
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedDateISO = iso;
        renderSidebar();
        openDayModal(iso);
      });
      list.appendChild(more);
    }

    day.appendChild(list);

    day.addEventListener("click", () => {
      selectedDateISO = iso;
      renderMonthGrid();
      renderSidebar();
    });

    // Duplo clique: criar evento de agenda naquele dia
    day.addEventListener("dblclick", () => {
      selectedDateISO = iso;
      prefillCalendarForm(iso);
      openModal("modal-calendar");
    });

    grid.appendChild(day);
  }
}

function renderSidebar() {
  const titleEl = $("sidebar-title");
  const listEl = $("sidebar-agenda");
  if (!titleEl || !listEl) return;

  const d = parseISODate(selectedDateISO);
  const label = d
    ? d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })
    : "Agenda";
  titleEl.textContent = `Agenda • ${label}`;

  listEl.innerHTML = "";
  const dayItems = itemsByDate[selectedDateISO] || [];
  if (!dayItems.length) {
    listEl.innerHTML = '<p class="small-text">Nenhum item neste dia.</p>';
    return;
  }

  dayItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "calendar-agenda-item";

    const dot = document.createElement("span");
    dot.className = "calendar-dot";
    dot.style.background = kindColor(item.kind, item);
    row.appendChild(dot);

    const content = document.createElement("div");

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.style.fontSize = "13px";
    title.textContent = item.title;
    content.appendChild(title);

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.color = "var(--text-secondary)";
    meta.textContent = item.meta || "";
    content.appendChild(meta);

    row.appendChild(content);

    row.addEventListener("click", () => {
      if (item.kind === "calendar") {
        // abre modal do dia (detalhes do evento ficam lá)
        openDayModal(selectedDateISO);
        return;
      }
      // Kanban: abre o card no dashboard
      window.open(`dashboard.html?open=${item.id}`, "_blank");
    });

    listEl.appendChild(row);
  });
}

function renderAgendaView() {
  if (viewMode !== "agenda") return;

  const titleEl = $("agenda-title");
  const listEl = $("agenda-list");
  if (!titleEl || !listEl) return;

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);

  const formatter = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
  titleEl.textContent = `Agenda • ${formatter.format(start)}`;

  const startKey = monthKey(start);

  // Filtra itens do mês
  const keys = Object.keys(itemsByDate)
    .filter((iso) => iso.startsWith(startKey))
    .sort();

  listEl.innerHTML = "";
  if (!keys.length) {
    listEl.innerHTML = '<p class="small-text">Nenhum item neste mês.</p>';
    return;
  }

  keys.forEach((iso) => {
    const dateHeader = document.createElement("div");
    dateHeader.style.margin = "12px 0 6px";
    dateHeader.style.fontWeight = "600";
    dateHeader.textContent = formatDateBR(iso);
    listEl.appendChild(dateHeader);

    (itemsByDate[iso] || []).forEach((item) => {
      const row = document.createElement("div");
      row.className = "calendar-agenda-item";

      const dot = document.createElement("span");
      dot.className = "calendar-dot";
      dot.style.background = kindColor(item.kind, item);
      row.appendChild(dot);

      const content = document.createElement("div");
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.style.fontSize = "13px";
      title.textContent = item.title;
      content.appendChild(title);

      const meta = document.createElement("div");
      meta.style.fontSize = "12px";
      meta.style.color = "var(--text-secondary)";
      meta.textContent = item.meta || "";
      content.appendChild(meta);

      row.appendChild(content);

      row.addEventListener("click", () => {
        selectedDateISO = iso;
        renderSidebar();
        if (item.kind === "calendar") {
          openDayModal(iso);
        } else {
          window.open(`dashboard.html?open=${item.id}`, "_blank");
        }
      });

      listEl.appendChild(row);
    });
  });
}

function openDayModal(iso) {
  const titleEl = $("day-modal-title");
  const listEl = $("day-modal-list");
  if (!titleEl || !listEl) return;

  selectedDateISO = iso;

  titleEl.textContent = `Itens • ${formatDateBR(iso)}`;
  listEl.innerHTML = "";

  const items = itemsByDate[iso] || [];
  if (!items.length) {
    listEl.innerHTML = '<p class="small-text">Nenhum item.</p>';
    openModal("modal-day");
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "archive-item";

    const tag =
      item.kind === "deadline"
        ? "Prazo"
        : item.kind === "calendar"
        ? "Agenda"
        : "Card";

    row.innerHTML = `
      <div class="archive-title">${item.title}</div>
      <div class="archive-meta">${tag}${item.meta ? ` • ${item.meta}` : ""}</div>
      <div class="archive-actions">
        <button type="button" class="btn-secondary small">Abrir</button>
      </div>
    `;

    const btn = row.querySelector("button");
    btn.addEventListener("click", () => {
      if (item.kind === "calendar") {
        showToast("Evento de calendário: detalhes na lateral.", "warning");
        closeModal("modal-day");
        return;
      }
      window.open(`dashboard.html?open=${item.id}`, "_blank");
      closeModal("modal-day");
    });

    // cor no título (borda esquerda)
    row.style.borderLeft = `4px solid ${kindColor(item.kind, item)}`;

    listEl.appendChild(row);
  });

  openModal("modal-day");
}

// --------------------------------------------------------------------------
// Create calendar event
// --------------------------------------------------------------------------

async function handleCalendarFormSubmit(e) {
  e.preventDefault();
  if (!currentUser?.email) {
    showToast("Sessão não carregada.", "error");
    return;
  }

  const title = $("cal-title")?.value?.trim();
  const date = $("cal-date")?.value;
  const start = $("cal-start")?.value;
  const end = $("cal-end")?.value;
  const desc = $("cal-desc")?.value?.trim() || "";
  const attendeesRaw = $("cal-attendees")?.value?.trim() || "";

  if (!title || !date) {
    showToast("Título e data são obrigatórios.", "warning");
    return;
  }

  const attendeesList = attendeesRaw
    ? attendeesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s)
    : [];

  const attendees = {};
  attendeesList.forEach((email) => {
    attendees[email.toLowerCase()] = true;
  });
  attendees[currentUser.email.toLowerCase()] = true;

  try {
    await push(ref(db, "calendarEvents"), {
      title,
      date,
      startTime: start || null,
      endTime: end || null,
      description: desc,
      attendees,
      createdBy: currentUser.email,
      createdByUid: currentUser.uid,
      createdAt: new Date().toISOString()
    });

    e.target.reset();
    closeModal("modal-calendar");
    showToast("Evento criado.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao criar evento.", "error");
  }
}
