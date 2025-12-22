// tools.js (corrigido: quando não autenticado, redireciona p/ login em vez de window.close())
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ref, onValue, push, update, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let currentUser = null;
let basePath = null;
let baseKind = null; // 'event' ou 'session'
let tool = "ishikawa";
let ishikawaData = {};
let ishikawaRootId = null;
let fmeaData = {};
let currentPdcaStage = "plan";
let currentMeta = {};

const SEVERITY_LABELS = {
  sem_dano: "Evento sem dano",
  leve: "Dano leve",
  moderado: "Dano moderado",
  grave: "Dano grave",
  obito: "Óbito",
  near_miss: "Near miss",
  nao_classificado: "Não classificado"
};

const EFFECT_PATTERNS = [
  { key: "queda", label: "Queda de paciente" },
  { key: "escleroterapia", label: "Déficit neurológico pós-escleroterapia" },
  { key: "esclerotepia", label: "Déficit neurológico pós-escleroterapia" },
  { key: "medicaç", label: "Evento envolvendo medicação" },
  { key: "medicac", label: "Evento envolvendo medicação" },
  { key: "erro de dose", label: "Erro de dose de medicamento" },
  { key: "dose", label: "Erro de dose de medicamento" },
  { key: "infecção", label: "Infecção relacionada à assistência" },
  { key: "infeccao", label: "Infecção relacionada à assistência" },
  { key: "cirurgia", label: "Intercorrência em procedimento cirúrgico" },
  { key: "atraso", label: "Atraso em atendimento ou processo" },
  { key: "falha", label: "Falha em processo assistencial" }
];

const TOOL_LABELS = {
  ishikawa: "Diagrama de Ishikawa",
  "5w2h": "5W2H",
  pdca: "Ciclo PDCA",
  fmea: "FMEA / HFMEA",
  notes: "Canvas de notas"
};

function goToLogin(withNext = true) {
  const file = window.location.pathname.split("/").pop() || "tools.html";
  const next = encodeURIComponent(file + window.location.search);
  const target = withNext ? `index.html?next=${next}` : "index.html";
  window.location.replace(target);
}

function capitalizeFirst(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
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

function generateIshikawaEffect(ev) {
  const type = ev.type || ev.toolType || "evento";
  const severityLabel = ev.severity ? (SEVERITY_LABELS[ev.severity] || ev.severity) : null;
  const unit = ev.unit || null;

  if (ev.ishikawaEffect && ev.ishikawaEffect.trim()) return ev.ishikawaEffect.trim();

  if (type === "evento") {
    const textSource = `${ev.title || ""} ${ev.desc || ""}`.toLowerCase();
    let matched = null;
    for (const p of EFFECT_PATTERNS) {
      if (textSource.includes(p.key)) { matched = p; break; }
    }
    if (matched) {
      let phrase = matched.label;
      if (severityLabel) phrase += ` com ${severityLabel.toLowerCase()}`;
      if (unit) phrase += ` na ${unit}`;
      return capitalizeFirst(phrase);
    }
    let base = "Evento adverso";
    if (severityLabel) base += ` (${severityLabel.toLowerCase()})`;
    if (unit) base += ` na ${unit}`;
    return capitalizeFirst(base);
  }

  if (type === "tarefa") return `Tarefa de gestão: ${ev.title || "atividade interna"}`;
  if (type === "projeto") return `Projeto de melhoria: ${ev.title || "projeto de melhoria"}`;

  if (ev.toolType) return `${TOOL_LABELS[ev.toolType] || "Ferramenta"}: ${ev.title || "Análise de risco"}`;

  return ev.title || "Análise de causa";
}

// ---------- PARSE DA URL ----------
const params = new URLSearchParams(window.location.search);
const eventId = params.get("eventId");
const sessionId = params.get("sessionId");
tool = (params.get("tool") || "ishikawa").toLowerCase();

if (sessionId) {
  baseKind = "session";
  basePath = `toolSessions/${sessionId}`;
} else if (eventId) {
  baseKind = "event";
  basePath = `events/${eventId}`;
} else {
  baseKind = null;
  basePath = null;
}

// ---------- AUTH ----------
onAuthStateChanged(auth, (user) => {
  if (!user) {
    goToLogin(true);
    return;
  }
  currentUser = user;
  initToolPage();
});

// ---------- INICIALIZAÇÃO ----------
function initToolPage() {
  const headerTitle = document.getElementById("tool-header-title");
  const breadcrumb = document.getElementById("tool-breadcrumb");
  const subtitle = document.getElementById("tool-subtitle");
  const avatar = document.getElementById("tool-avatar");
  const contextLabel = document.getElementById("tool-context-label");

  if (headerTitle) headerTitle.textContent = TOOL_LABELS[tool] || "Ferramentas";

  document.querySelectorAll(".tool-section").forEach((sec) => sec.classList.add("hidden"));
  const activeSection = document.getElementById(`tool-${tool}`);
  if (activeSection) activeSection.classList.remove("hidden");

  if (!basePath) {
    if (breadcrumb) breadcrumb.textContent = "Canvas solto (sem vínculo com card)";
    if (subtitle) subtitle.textContent = "Use este espaço para discutir riscos, melhorias ou ideias gerais.";
    if (avatar) avatar.textContent = (currentUser.email?.[0] || "?").toUpperCase();
    if (contextLabel) contextLabel.textContent = "Canvas solto";
    bindToolHandlers();
    return;
  }

  const baseRef = ref(db, basePath);
  onValue(baseRef, (snap) => {
    const data = snap.val() || {};
    currentMeta = data;

    const title = data.title || data.name || "Sem título";
    const prefix = baseKind === "event" ? "Evento / card" : "Canvas solto";
    if (breadcrumb) breadcrumb.textContent = `${prefix} • ${title}`;

    if (baseKind === "event") {
      const typeLabel = (data.type || "evento").toUpperCase();
      const sevLabel = data.severity ? (SEVERITY_LABELS[data.severity] || data.severity) : "Sem classificação";
      const unit = data.unit || "";
      if (subtitle) subtitle.textContent = `${typeLabel} • ${sevLabel}${unit ? " • " + unit : ""}`;
      if (contextLabel) contextLabel.textContent = "Evento / card";
    } else {
      if (subtitle) {
        subtitle.textContent = `Ferramenta: ${TOOL_LABELS[data.toolType] || "Ferramenta"} • Criado em ${
          data.createdAt ? new Date(data.createdAt).toLocaleDateString("pt-BR") : "-"
        }`;
      }
      if (contextLabel) contextLabel.textContent = "Canvas solto";
    }

    if (avatar) avatar.textContent = (title[0] || "?").toUpperCase();

    if (tool === "ishikawa") initIshikawa(data);
    if (tool === "5w2h") init5W2H();
    if (tool === "pdca") initPdca();
    if (tool === "fmea") initFmea();
    if (tool === "notes") initNotes();
  });

  bindToolHandlers();
}

function bindToolHandlers() {
  if (tool === "ishikawa") {
    const addBtn = document.getElementById("btn-ish-add");
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = "true";
      addBtn.addEventListener("click", () => {
        const input = document.getElementById("ishikawa-text");
        if (input) input.focus();
      });
    }
  }

  if (tool === "pdca") {
    document.querySelectorAll(".pdca-chip").forEach((chip) => {
      if (chip.dataset.bound) return;
      chip.dataset.bound = "true";
      chip.addEventListener("click", () => setPdcaStage(chip.dataset.stage));
    });
  }
}

// ---------- ISHIKAWA ----------
function initIshikawa(meta) {
  const effectTitle = document.getElementById("ishikawa-effect-title");
  if (effectTitle) {
    effectTitle.textContent = generateIshikawaEffect(meta);
    effectTitle.onblur = () => {
      const custom = effectTitle.textContent.trim();
      if (!basePath) return;
      update(ref(db, basePath), { ishikawaEffect: custom }).catch(() => {});
    };
  }

  if (!basePath) return;

  onValue(ref(db, `${basePath}/ishikawaRootId`), (snap) => {
    ishikawaRootId = snap.val() || null;
    renderIshikawa();
  });

  onValue(ref(db, `${basePath}/ishikawa`), (snap) => {
    ishikawaData = snap.val() || {};
    renderIshikawa();
  });
}

function renderIshikawa() {
  document.querySelectorAll(".ishikawa-dropzone").forEach((zone) => (zone.innerHTML = ""));
  const pool = document.getElementById("ishikawa-pool");
  if (pool) pool.innerHTML = "";

  const entries = Object.entries(ishikawaData || {});
  entries.forEach(([id, cause]) => {
    const chip = document.createElement("div");
    chip.className = "cause-chip";
    chip.draggable = true;
    chip.dataset.id = id;
    chip.dataset.impact = cause.impact || 1;
    chip.innerHTML = `
      <span class="impact-dot"></span>
      <span>${cause.text || "Causa"}</span>
    `;
    chip.ondragstart = (ev) => ev.dataTransfer.setData("text/ishikawa-id", id);

    if (ishikawaRootId && ishikawaRootId === id) chip.classList.add("root");

    const cat = cause.cat || null;
    const zone = cat ? document.querySelector(`.ishikawa-dropzone[data-cat="${cat}"]`) : null;
    if (zone) zone.appendChild(chip);
    else pool.appendChild(chip);
  });

  renderIshikawaRootInsight();
}

function renderIshikawaRootInsight() {
  const box = document.getElementById("ishikawa-root-text");
  if (!box) return;

  const entries = Object.entries(ishikawaData || {});
  if (!entries.length) {
    box.textContent = "Ainda não há causas mapeadas. Adicione e arraste para as categorias 6M.";
    return;
  }

  if (ishikawaRootId && ishikawaData[ishikawaRootId]) {
    const c = ishikawaData[ishikawaRootId];
    box.textContent = `Causa raiz definida: [${c.cat || "Sem categoria"}] ${c.text}`;
    return;
  }

  const byCat = {};
  entries.forEach(([id, c]) => {
    const cat = c.cat || "Outros";
    const impact = Number(c.impact || 1);
    if (!byCat[cat]) byCat[cat] = { total: 0, causes: [] };
    byCat[cat].total += impact;
    byCat[cat].causes.push({ id, impact, text: c.text });
  });

  const sortedCats = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);
  const [rootCat, rootInfo] = sortedCats[0];
  rootInfo.causes.sort((a, b) => b.impact - a.impact);
  const rootCause = rootInfo.causes[0];

  if (rootCause) {
    box.textContent = `Insight automático: a categoria com maior peso é "${rootCat}". Causa provável raiz: ${rootCause.text}.`;

    if (basePath) update(ref(db, basePath), { ishikawaRootId: rootCause.id }).catch(() => {});
  }
}

window.ishAllowDrop = (ev) => ev.preventDefault();
window.ishDrop = (ev) => {
  ev.preventDefault();
  if (!basePath) return;
  const id = ev.dataTransfer.getData("text/ishikawa-id");
  if (!id) return;

  let target = ev.target;
  while (target && !target.classList.contains("ishikawa-dropzone")) target = target.parentElement;
  if (!target) return;

  const cat = target.dataset.cat;
  if (!cat) return;

  update(ref(db, `${basePath}/ishikawa/${id}`), { cat });
  showToast("Causa movida para " + cat + ".");
};

window.cancelIshikawa = () => {
  const input = document.getElementById("ishikawa-text");
  if (input) input.value = "";
};

window.confirmIshikawa = () => {
  if (!basePath) {
    showToast("Sem destino configurado para salvar.", "error");
    return;
  }
  const cat = document.getElementById("ishikawa-cat").value;
  const text = document.getElementById("ishikawa-text").value.trim();
  const impact = Number(document.getElementById("ishikawa-impact").value || "1");

  if (!text) {
    showToast("Descreva a causa para adicioná-la ao diagrama.", "warning");
    return;
  }

  push(ref(db, `${basePath}/ishikawa`), {
    cat,
    text,
    impact,
    createdBy: currentUser?.email || null,
    createdAt: new Date().toISOString()
  }).then(() => {
    const input = document.getElementById("ishikawa-text");
    if (input) input.value = "";
  });

  if (baseKind === "event") update(ref(db, basePath + "/toolsUsed"), { ishikawa: true }).catch(() => {});
  showToast("Causa adicionada.");
};

// ---------- 5W2H ----------
function init5W2H() {
  if (!basePath) return;
  onValue(ref(db, `${basePath}/5w2h`), (snap) => render5w2hList(snap.val() || {}));
}

function render5w2hList(data) {
  const list = document.getElementById("5w2h-list");
  if (!list) return;
  list.innerHTML = "";
  Object.values(data).forEach((action) => {
    const when = action.when ? new Date(action.when).toLocaleDateString("pt-BR") : "-";
    const card = document.createElement("div");
    card.className = "w2-card";
    card.innerHTML = `
      <div class="w2-header">
        <strong>${action.what || "Ação"}</strong>
        <span class="w2-status">${action.status || ""}</span>
      </div>
      <div class="w2-tags">
        ${action.who ? `<span class="w2-tag">Quem: ${action.who}</span>` : ""}
        ${action.why ? `<span class="w2-tag">Por quê: ${action.why}</span>` : ""}
        ${action.where ? `<span class="w2-tag">Onde: ${action.where}</span>` : ""}
        ${action.when ? `<span class="w2-tag">Quando: ${when}</span>` : ""}
        ${action.howmuch ? `<span class="w2-tag">Custo: ${action.howmuch}</span>` : ""}
      </div>
      ${action.how ? `<div style="margin-top:4px;">${action.how}</div>` : ""}
    `;
    list.appendChild(card);
  });
}

window.add5W2H = () => document.getElementById("5w2h-form")?.classList.remove("hidden");
window.cancel5W2H = () => document.getElementById("5w2h-form")?.classList.add("hidden");
window.confirm5W2H = () => {
  if (!basePath) {
    showToast("Sem destino configurado para salvar.", "error");
    return;
  }

  const what = document.getElementById("w2-what").value.trim();
  const who = document.getElementById("w2-who").value.trim();
  const why = document.getElementById("w2-why").value.trim();
  const where = document.getElementById("w2-where").value.trim();
  const when = document.getElementById("w2-when").value;
  const how = document.getElementById("w2-how").value.trim();
  const howmuch = document.getElementById("w2-howmuch").value.trim();

  if (!what) {
    showToast("Descreva o que será feito (What).", "warning");
    return;
  }

  push(ref(db, `${basePath}/5w2h`), {
    what, who, why, where, when, how, howmuch,
    createdBy: currentUser?.email || null,
    createdAt: new Date().toISOString(),
    status: "Planejado"
  });

  if (baseKind === "event") update(ref(db, basePath + "/toolsUsed"), { w2h: true }).catch(() => {});

  ["w2-what", "w2-who", "w2-why", "w2-where", "w2-when", "w2-how", "w2-howmuch"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  document.getElementById("5w2h-form")?.classList.add("hidden");
  showToast("Ação 5W2H adicionada.");
};

// ---------- PDCA ----------
function initPdca() {
  if (!basePath) return;
  onValue(ref(db, `${basePath}/pdca`), (snap) => {
    const pdca = snap.val() || {};
    document.getElementById("pdca-plan").value = pdca.plan || "";
    document.getElementById("pdca-do").value = pdca.do || "";
    document.getElementById("pdca-check").value = pdca.check || "";
    document.getElementById("pdca-act").value = pdca.act || "";
    setPdcaStage(pdca.stage || "plan");
  });
}

function setPdcaStage(stage) {
  currentPdcaStage = stage || "plan";
  const labelMap = { plan: "Planejar", do: "Executar", check: "Checar", act: "Agir" };
  const labelEl = document.getElementById("pdca-current-label");
  if (labelEl) labelEl.textContent = labelMap[currentPdcaStage] || "Selecione a fase";

  document.querySelectorAll(".pdca-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.stage === currentPdcaStage);
  });

  document.querySelectorAll(".pdca-stage-form").forEach((form) => {
    form.classList.toggle("active", form.dataset.stage === currentPdcaStage);
  });

  document.querySelectorAll(".pdca-segment").forEach((seg) => seg.classList.remove("active"));
  document.querySelector(`.pdca-segment.pdca-${currentPdcaStage}`)?.classList.add("active");
}

window.savePdca = async () => {
  if (!basePath) {
    showToast("Sem destino configurado para salvar.", "error");
    return;
  }

  const data = {
    stage: currentPdcaStage,
    plan: document.getElementById("pdca-plan").value,
    do: document.getElementById("pdca-do").value,
    check: document.getElementById("pdca-check").value,
    act: document.getElementById("pdca-act").value,
    updatedBy: currentUser?.email || null,
    updatedAt: new Date().toISOString()
  };

  try {
    await update(ref(db, basePath + "/pdca"), data);
    if (baseKind === "event") await update(ref(db, basePath + "/toolsUsed"), { pdca: true });
    showToast("PDCA salvo.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao salvar PDCA.", "error");
  }
};

window.resetPdca = () => {
  ["pdca-plan", "pdca-do", "pdca-check", "pdca-act"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  setPdcaStage("plan");
};

// ---------- FMEA ----------
const HFMEA_SEVERITY = {
  4: "Catastrófico",
  3: "Maior",
  2: "Moderado",
  1: "Menor"
};

const HFMEA_PROB = {
  4: "Frequente",
  3: "Ocasional",
  2: "Incomum",
  1: "Remoto"
};

function hfmeaRiskFromScore(score) {
  const s = Number(score || 0);
  if (s >= 12) return { label: "Alto", cls: "risk-high" };
  if (s >= 8) return { label: "Significativo", cls: "risk-medium" };
  if (s >= 4) return { label: "Moderado", cls: "risk-low" };
  return { label: "Baixo", cls: "risk-info" };
}

function hfmeaDecision(hazardScore, singlePoint, controlEffective, detectable) {
  const score = Number(hazardScore || 0);

  // Referência prática (HFMEA / VA NCPS):
  // - Geralmente, scores >= 8 entram em priorização.
  // - A árvore de decisão considera: ponto único, controle efetivo, detectabilidade.
  // Aqui uma versão "enxuta" para UX.
  if (score < 8) {
    return {
      status: "monitor",
      text: "Risco baixo/moderado: manter controles e monitorar."
    };
  }

  if (!singlePoint && controlEffective && detectable) {
    return {
      status: "monitor",
      text: "Score alto, porém há barreiras e detectabilidade: manter controles e monitorar."
    };
  }

  if (!controlEffective || !detectable) {
    return {
      status: "action",
      text: "Requer plano de ação: controles insuficientes e/ou baixa detectabilidade."
    };
  }

  if (singlePoint) {
    return {
      status: "action",
      text: "Requer plano de ação: ponto único de falha (reduzir dependência de uma única barreira)."
    };
  }

  return {
    status: "action",
    text: "Requer avaliação e possível ação corretiva/preventiva."
  };
}

function getFmeaFormValues() {
  const step = document.getElementById("fmea-step")?.value?.trim() || "";
  const failureMode = document.getElementById("fmea-failure")?.value?.trim() || "";
  const cause = document.getElementById("fmea-cause")?.value?.trim() || "";
  const effect = document.getElementById("fmea-effect")?.value?.trim() || "";
  const controls = document.getElementById("fmea-controls")?.value?.trim() || "";

  const severityCat = Number(document.getElementById("fmea-severity-cat")?.value || "2");
  const probCat = Number(document.getElementById("fmea-prob-cat")?.value || "3");
  const hazardScore = severityCat * probCat;

  const singlePoint = !!document.getElementById("fmea-single-point")?.checked;
  const controlEffective = !!document.getElementById("fmea-control-effective")?.checked;
  const detectable = !!document.getElementById("fmea-detectable")?.checked;

  const action = document.getElementById("fmea-action")?.value?.trim() || "";
  const owner = document.getElementById("fmea-owner")?.value?.trim() || "";
  const due = document.getElementById("fmea-due")?.value || "";

  return {
    step,
    failureMode,
    cause,
    effect,
    controls,
    severityCat,
    probCat,
    hazardScore,
    singlePoint,
    controlEffective,
    detectable,
    action,
    owner,
    due
  };
}

function updateFmeaPreview() {
  const hazardEl = document.getElementById("fmea-hazard");
  const recEl = document.getElementById("fmea-recommendation");
  if (!hazardEl || !recEl) return;

  const v = getFmeaFormValues();
  hazardEl.value = String(v.hazardScore);
  const risk = hfmeaRiskFromScore(v.hazardScore);
  const decision = hfmeaDecision(v.hazardScore, v.singlePoint, v.controlEffective, v.detectable);

  recEl.innerHTML = `<strong>${risk.label}</strong> • ${decision.text}`;
}

function bindFmeaPreviewHandlers() {
  const ids = [
    "fmea-severity-cat",
    "fmea-prob-cat",
    "fmea-single-point",
    "fmea-control-effective",
    "fmea-detectable"
  ];

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = "true";
    el.addEventListener("change", updateFmeaPreview);
  });
}

function initFmea() {
  if (!basePath) return;

  bindFmeaPreviewHandlers();
  updateFmeaPreview();

  onValue(ref(db, `${basePath}/fmea`), (snap) => {
    fmeaData = snap.val() || {};
    renderFmeaList();
  });
}

function renderFmeaList() {
  const list = document.getElementById("fmea-list");
  if (!list) return;
  list.innerHTML = "";

  const entries = Object.entries(fmeaData || {}).map(([id, data]) => ({ id, ...data }));
  if (!entries.length) {
    list.innerHTML = '<div class="small-text">Nenhum modo de falha cadastrado ainda.</div>';
    return;
  }

  entries.sort((a, b) => {
    const as = Number(a.hazardScore ?? a.rpn ?? 0);
    const bs = Number(b.hazardScore ?? b.rpn ?? 0);
    return bs - as;
  });

  entries.forEach((item) => {
    const score = Number(item.hazardScore ?? item.rpn ?? 0);
    const risk = item.riskLevel
      ? { label: item.riskLevel, cls: "risk-medium" }
      : hfmeaRiskFromScore(score);

    const sLabel = item.severityCat ? `${item.severityCat} — ${HFMEA_SEVERITY[item.severityCat] || ""}` : null;
    const pLabel = item.probCat ? `${item.probCat} — ${HFMEA_PROB[item.probCat] || ""}` : null;

    const row = document.createElement("div");
    row.className = "fmea-row";
    row.innerHTML = `
      <div class="fmea-row-header">
        <div>
          <div class="fmea-row-title">${item.step || "Etapa / processo"}</div>
          <div class="fmea-row-meta">${item.failureMode ? `Modo de falha: <strong>${item.failureMode}</strong>` : ""}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <span class="risk-badge ${risk.cls}">${risk.label} • ${score || "-"}</span>
          <button class="btn-tertiary small" data-del="${item.id}"><i class="ph-bold ph-trash"></i> Excluir</button>
        </div>
      </div>

      <div class="fmea-row-body">
        <div class="fmea-field">
          <strong>Causa</strong>
          <div>${item.cause || "-"}</div>
        </div>
        <div class="fmea-field">
          <strong>Efeito</strong>
          <div>${item.effect || "-"}</div>
        </div>
        <div class="fmea-field">
          <strong>Controles atuais</strong>
          <div>${item.controls || "-"}</div>
        </div>
        <div class="fmea-field">
          <strong>Ação</strong>
          <div>${item.action || "-"}</div>
          ${item.owner ? `<div class="small-text">Responsável: ${item.owner}${item.due ? ` • Prazo: ${item.due}` : ""}</div>` : ""}
        </div>
      </div>

      <div class="fmea-decision-pills">
        ${sLabel ? `<span class="decision-pill">Severidade: ${sLabel}</span>` : ""}
        ${pLabel ? `<span class="decision-pill">Prob.: ${pLabel}</span>` : ""}
        ${typeof item.singlePoint === "boolean" ? `<span class="decision-pill">Ponto único: ${item.singlePoint ? "Sim" : "Não"}</span>` : ""}
        ${typeof item.controlEffective === "boolean" ? `<span class="decision-pill">Controle efetivo: ${item.controlEffective ? "Sim" : "Não"}</span>` : ""}
        ${typeof item.detectable === "boolean" ? `<span class="decision-pill">Detectável: ${item.detectable ? "Sim" : "Não"}</span>` : ""}
        ${item.rpn ? `<span class="decision-pill">RPN (legado): ${item.rpn}</span>` : ""}
      </div>
    `;

    const delBtn = row.querySelector("button[data-del]");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        if (!basePath) return;
        const id = delBtn.getAttribute("data-del");
        try {
          await remove(ref(db, `${basePath}/fmea/${id}`));
          showToast("Item removido.");
        } catch (err) {
          console.error(err);
          showToast("Erro ao remover item.", "error");
        }
      });
    }

    list.appendChild(row);
  });
}

window.addFmea = () => {
  document.getElementById("fmea-form")?.classList.remove("hidden");
  bindFmeaPreviewHandlers();
  updateFmeaPreview();
};

window.cancelFmea = () => {
  document.getElementById("fmea-form")?.classList.add("hidden");
  const resetIds = [
    "fmea-step",
    "fmea-failure",
    "fmea-cause",
    "fmea-effect",
    "fmea-controls",
    "fmea-action",
    "fmea-owner",
    "fmea-due"
  ];
  resetIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const sev = document.getElementById("fmea-severity-cat");
  const prob = document.getElementById("fmea-prob-cat");
  if (sev) sev.value = "2";
  if (prob) prob.value = "3";
  const sp = document.getElementById("fmea-single-point");
  const ce = document.getElementById("fmea-control-effective");
  const det = document.getElementById("fmea-detectable");
  if (sp) sp.checked = false;
  if (ce) ce.checked = true;
  if (det) det.checked = true;
  updateFmeaPreview();
};

window.confirmFmea = async () => {
  if (!basePath) {
    showToast("Sem destino configurado para salvar.", "error");
    return;
  }

  const v = getFmeaFormValues();
  if (!v.step || !v.failureMode) {
    showToast("Informe pelo menos a etapa do processo e o modo de falha.", "warning");
    return;
  }

  const risk = hfmeaRiskFromScore(v.hazardScore);
  const decision = hfmeaDecision(v.hazardScore, v.singlePoint, v.controlEffective, v.detectable);

  try {
    await push(ref(db, `${basePath}/fmea`), {
      step: v.step,
      failureMode: v.failureMode,
      cause: v.cause,
      effect: v.effect,
      controls: v.controls,
      severityCat: v.severityCat,
      probCat: v.probCat,
      hazardScore: v.hazardScore,
      riskLevel: risk.label,
      decision: decision.status,
      decisionText: decision.text,
      singlePoint: v.singlePoint,
      controlEffective: v.controlEffective,
      detectable: v.detectable,
      action: v.action,
      owner: v.owner,
      due: v.due || null,
      createdBy: currentUser?.email || null,
      createdAt: new Date().toISOString()
    });

    if (baseKind === "event") {
      await update(ref(db, `${basePath}/toolsUsed`), { fmea: true });
    }

    showToast("Modo de falha registrado.");
    window.cancelFmea();
  } catch (err) {
    console.error(err);
    showToast("Erro ao salvar HFMEA.", "error");
  }
};

window.generateFmeaTemplate = async () => {
  if (!basePath) {
    showToast("Abra um card para gerar template.", "warning");
    return;
  }

  const source = `${currentMeta?.title || ""} ${currentMeta?.desc || ""}`.toLowerCase();
  const isEscleroterapia = source.includes("escleroter") || source.includes("polidoc") || source.includes("espuma");

  const templates = isEscleroterapia
    ? [
        {
          step: "Pré-consulta / avaliação",
          failureMode: "Orientações incompletas (medicações, jejum, contraindicações)",
          cause: "Protocolo não padronizado / comunicação falha",
          effect: "Aumento do risco de complicações e atraso em conduta",
          controls: "Termo de consentimento; avaliação médica; checklist de preparo",
          severityCat: 3,
          probCat: 3,
          singlePoint: false,
          controlEffective: false,
          detectable: true
        },
        {
          step: "Prescrição / preparo do esclerosante",
          failureMode: "Concentração/dose inadequada do polidocanol",
          cause: "Ausência de dupla checagem / padronização de diluição",
          effect: "Risco de evento neurológico/embólico; reação adversa",
          controls: "Padronização de concentrações; dupla checagem; rotulagem",
          severityCat: 4,
          probCat: 2,
          singlePoint: true,
          controlEffective: false,
          detectable: false
        },
        {
          step: "Procedimento (técnica / aplicação)",
          failureMode: "Aplicação inadvertida intravascular ou técnica inadequada",
          cause: "Treinamento insuficiente / variação de prática",
          effect: "Déficit neurológico; necessidade de remoção; dano ao paciente",
          controls: "Treinamento; supervisão; protocolo do procedimento",
          severityCat: 4,
          probCat: 2,
          singlePoint: false,
          controlEffective: false,
          detectable: false
        },
        {
          step: "Pós-procedimento (observação)",
          failureMode: "Monitoramento insuficiente ou alta precoce",
          cause: "Fluxo assistencial / estrutura de observação limitada",
          effect: "Atraso na identificação e resposta à intercorrência",
          controls: "Tempo mínimo de observação; sinais de alerta; registro",
          severityCat: 3,
          probCat: 3,
          singlePoint: false,
          controlEffective: false,
          detectable: true
        },
        {
          step: "Resposta à emergência / remoção",
          failureMode: "Atraso na remoção para unidade de referência",
          cause: "Dependência de SAMU / comunicação / disponibilidade",
          effect: "Atraso em diagnóstico e tratamento de AVC",
          controls: "Plano de contingência; contatos; protocolo de escalonamento",
          severityCat: 4,
          probCat: 3,
          singlePoint: true,
          controlEffective: false,
          detectable: true
        }
      ]
    : [
        {
          step: "Processo assistencial",
          failureMode: "Falha de comunicação entre equipe",
          cause: "Passagem de plantão incompleta / ruído de informação",
          effect: "Atraso em conduta / risco ao paciente",
          controls: "SBAR / checklist de passagem de plantão",
          severityCat: 3,
          probCat: 3,
          singlePoint: false,
          controlEffective: false,
          detectable: true
        },
        {
          step: "Documentação",
          failureMode: "Registro incompleto do evento",
          cause: "Sobrecarga / falta de padrão",
          effect: "Investigação prejudicada / recorrência",
          controls: "Campos obrigatórios / padronização / auditoria",
          severityCat: 2,
          probCat: 3,
          singlePoint: false,
          controlEffective: false,
          detectable: true
        }
      ];

  try {
    const now = new Date().toISOString();
    for (const t of templates) {
      const hazardScore = (t.severityCat || 2) * (t.probCat || 3);
      const risk = hfmeaRiskFromScore(hazardScore);
      const decision = hfmeaDecision(hazardScore, t.singlePoint, t.controlEffective, t.detectable);
      await push(ref(db, `${basePath}/fmea`), {
        step: t.step,
        failureMode: t.failureMode,
        cause: t.cause,
        effect: t.effect,
        controls: t.controls,
        severityCat: t.severityCat,
        probCat: t.probCat,
        hazardScore,
        riskLevel: risk.label,
        decision: decision.status,
        decisionText: decision.text,
        singlePoint: t.singlePoint,
        controlEffective: t.controlEffective,
        detectable: t.detectable,
        action: "",
        owner: "",
        due: null,
        createdBy: currentUser?.email || null,
        createdAt: now
      });
    }
    if (baseKind === "event") {
      await update(ref(db, `${basePath}/toolsUsed`), { fmea: true });
    }
    showToast("Template HFMEA criado.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao gerar template.", "error");
  }
};

// ---------- NOTES ----------
function initNotes() {
  if (!basePath) return;
  onValue(ref(db, `${basePath}/notes`), (snap) => {
    const data = snap.val() || {};
    const textArea = document.getElementById("notes-text");
    const status = document.getElementById("notes-status");
    if (textArea) textArea.value = data.text || "";
    if (status && data.updatedAt) status.textContent = `Última atualização: ${new Date(data.updatedAt).toLocaleString("pt-BR")}`;
  });
}

window.saveNotes = async () => {
  if (!basePath) {
    showToast("Sem destino configurado para salvar.", "error");
    return;
  }
  const textArea = document.getElementById("notes-text");
  if (!textArea) return;

  try {
    await update(ref(db, `${basePath}/notes`), {
      text: textArea.value,
      updatedBy: currentUser?.email || null,
      updatedAt: new Date().toISOString()
    });
    document.getElementById("notes-status").textContent = `Última atualização: ${new Date().toLocaleString("pt-BR")}`;
    showToast("Notas salvas.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao salvar notas.", "error");
  }
};
