import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, push, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// COLOQUE SUAS CHAVES AQUI
const firebaseConfig = {
  apiKey: "AIzaSyC83yVn1KPosgCDtOnvBpVmfdqJSkPlots",
  authDomain: "qflow-glass.firebaseapp.com",
  databaseURL: "https://qflow-glass-default-rtdb.firebaseio.com",
  projectId: "qflow-glass",
  storageBucket: "qflow-glass.firebasestorage.app",
  messagingSenderId: "841998306234",
  appId: "1:841998306234:web:1087a998bd2be099e66b83"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Cores disponíveis para usuários
const BRAND_COLORS = ['#276b38', '#e97b28', '#007AFF', '#5856D6', '#FF2D55', '#FF9500'];

// Estado global
let currentUser = null;
let currentCardId = null;
let eventsSnapshot = {};
let activeSeverityFilter = 'all';
let searchTerm = '';
let currentPdcaStage = 'plan';

// Mapeamentos
const SEVERITY_LABELS = {
  sem_dano: "Evento sem dano",
  leve: "Dano leve",
  moderado: "Dano moderado",
  grave: "Dano grave",
  obito: "Óbito",
  near_miss: "Near miss"
};

const PDCA_LABELS = {
  plan: "Plan",
  do: "Do",
  check: "Check",
  act: "Act"
};

// ---------- UI Helpers ----------

function showToast(message, variant = "success") {
  const toast = document.getElementById("toast");
  const msgEl = document.getElementById("toast-message");
  if (!toast || !msgEl) return;

  msgEl.textContent = message;

  const iconSpan = toast.querySelector(".toast-icon i");
  if (iconSpan) {
    if (variant === "error") {
      iconSpan.className = "ph-bold ph-x-circle";
    } else if (variant === "warning") {
      iconSpan.className = "ph-bold ph-warning-circle";
    } else {
      iconSpan.className = "ph-bold ph-check-circle";
    }
  }

  toast.classList.add("visible");
  setTimeout(() => {
    toast.classList.remove("visible");
  }, 2600);
}

function formatShortDate(dateStr) {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

// ---------- Inicialização de UI ----------

document.addEventListener('DOMContentLoaded', () => {
  // Gera opções de cores no login
  const colorContainer = document.getElementById('color-options');
  BRAND_COLORS.forEach(color => {
    const dot = document.createElement('div');
    dot.className = 'color-dot';
    dot.style.backgroundColor = color;
    dot.dataset.color = color;
    dot.onclick = () => selectColor(color, dot);
    colorContainer.appendChild(dot);
  });

  // Marca cores já utilizadas
  onValue(ref(db, 'users'), (snapshot) => {
    const users = snapshot.val() || {};
    const usedColors = new Set(
      Object.values(users)
        .map(u => u && u.color)
        .filter(Boolean)
    );

    document.querySelectorAll('.color-dot').forEach(dot => {
      const color = dot.dataset.color;
      if (usedColors.has(color)) {
        dot.classList.add('taken');
      }
    });
  });

  // Chips PDCA
  document.querySelectorAll('.pdca-chip').forEach(chip => {
    chip.addEventListener('click', () => setPdcaStage(chip.dataset.stage));
  });
});

// ---------- Lógica de cores (evitar duplicidade) ----------

async function selectColor(color, element) {
  // Verifica se já está em uso no banco
  const snapshot = await get(ref(db, 'users'));
  const users = snapshot.val() || {};
  const isTaken = Object.values(users).some(u => u && u.color === color);

  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));

  if (isTaken) {
    element.classList.add('taken');
    showToast("Esta cor já está sendo usada por outro membro da equipe. Escolha outra.", "warning");
    return;
  }

  element.classList.add('selected');
  document.getElementById('selected-color').value = color;
}

// ---------- AUTH ----------

const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const color = document.getElementById('selected-color').value;

  if (!color) {
    showToast("Por favor, escolha sua identidade visual.", "warning");
    return;
  }

  try {
    const userCred = await signInWithEmailAndPassword(auth, email, password);
    // Salva cor no perfil do usuário
    await update(ref(db, `users/${userCred.user.uid}`), { email, color });
    showToast("Login realizado com sucesso.");
  } catch (error) {
    console.error(error);
    showToast("Acesso negado: " + error.message, "error");
  }
});

onAuthStateChanged(auth, async (user) => {
  const loginScreen = document.getElementById('login-screen');
  const dashboardScreen = document.getElementById('dashboard-screen');

  if (user) {
    const snapshot = await get(ref(db, `users/${user.uid}`));
    currentUser = snapshot.val() || { email: user.email, color: '#276b38' };

    // Atualiza tema dinâmico pela cor do usuário
    document.documentElement.style.setProperty('--accent', currentUser.color || '#276b38');

    // Alterna telas
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');

    // Atualiza UI do usuário
    const name = (currentUser.email || '').split('@')[0];
    document.getElementById('user-name').innerText = name || 'Usuário';
    const avatar = document.getElementById('user-avatar');
    avatar.style.backgroundColor = currentUser.color || '#999';
    avatar.innerText = (currentUser.email || 'U')[0].toUpperCase();

    attachBoardListeners();
    initKanban();
  } else {
    loginScreen.classList.remove('hidden');
    dashboardScreen.classList.add('hidden');
  }
});

window.logout = () => signOut(auth);

// ---------- Motor de Insights ONA (NO 21) ----------
// Baseado na tabela da página 8 da norma enviada
function getOnaDeadline(severity, dateStr) {
  if (!dateStr) {
    return {
      date: "--/--",
      daysLeft: 0,
      label: "Sem data"
    };
  }

  const eventDate = new Date(dateStr);
  const today = new Date();
  let daysLimit = 30; // padrão
  let mandatory = false;

  // Regras NO 21 (ajuste conforme norma)
  if (severity === 'grave' || severity === 'obito') {
    daysLimit = 5; // Prazo crítico
    mandatory = true;
  } else if (severity === 'moderado') {
    daysLimit = 10;
    mandatory = true; // tratamos "fortemente rec" como obrigatório para segurança
  } else if (severity === 'leve' || severity === 'sem_dano' || severity === 'near_miss') {
    daysLimit = 10;
  }

  const deadline = new Date(eventDate);
  deadline.setDate(deadline.getDate() + daysLimit);

  const diff = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));

  return {
    date: deadline.toLocaleDateString('pt-BR'),
    daysLeft: diff,
    label: mandatory ? 'Notificação obrigatória' : 'Notificação recomendada'
  };
}

// ---------- KANBAN / BOARD ----------

function attachBoardListeners() {
  const searchInput = document.getElementById('search-input');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = 'true';
    searchInput.addEventListener('input', (e) => {
      searchTerm = e.target.value.toLowerCase();
      renderKanban();
    });
  }

  document.querySelectorAll('.chip-filter').forEach(btn => {
    if (!btn.dataset.bound) {
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chip-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSeverityFilter = btn.dataset.severity || 'all';
        renderKanban();
      });
    }
  });
}

function initKanban() {
  onValue(ref(db, 'events'), (snapshot) => {
    eventsSnapshot = snapshot.val() || {};
    renderKanban();
    updateMetrics();
  });
}

function passesFilter(item) {
  if (!item) return false;

  // Severidade
  if (activeSeverityFilter === 'grave') {
    if (item.severity !== 'grave' && item.severity !== 'obito') return false;
  } else if (activeSeverityFilter === 'moderado') {
    if (item.severity !== 'moderado') return false;
  } else if (activeSeverityFilter === 'leve') {
    if (!['leve', 'sem_dano', 'near_miss'].includes(item.severity)) return false;
  }

  // Busca textual
  if (searchTerm) {
    const text = `${item.title || ''} ${item.desc || ''} ${item.unit || ''}`.toLowerCase();
    if (!text.includes(searchTerm)) return false;
  }

  return true;
}

function renderKanban() {
  const statuses = ['backlog', 'doing', 'done'];

  statuses.forEach(status => {
    const listEl = document.getElementById(`list-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    if (!listEl || !countEl) return;

    listEl.innerHTML = '';
    let count = 0;

    Object.entries(eventsSnapshot).forEach(([key, item]) => {
      if (!item || (item.status || 'backlog') !== status) return;
      if (!passesFilter(item)) return;

      const card = createCardElement(key, item);
      listEl.appendChild(card);
      count++;
    });

    countEl.innerText = count;
  });
}

function updateMetrics() {
  const events = Object.values(eventsSnapshot || {});
  if (!events.length) {
    document.getElementById('metric-open').innerText = 0;
    document.getElementById('metric-ontrack').innerText = 0;
    document.getElementById('metric-ontrack-sub').innerText = '0 dentro / 0 vencidos';
    document.getElementById('metric-today').innerText = 0;
    document.getElementById('metric-critical').innerText = 0;
    return;
  }

  let openCount = 0;
  let onTrack = 0;
  let expired = 0;
  let todayCount = 0;
  let criticalActive = 0;

  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  events.forEach(item => {
    if (!item) return;

    if (item.status !== 'done') {
      openCount++;
    }

    const ona = getOnaDeadline(item.severity, item.date);
    if (ona.daysLeft >= 0) onTrack++;
    else expired++;

    if (item.date === todayISO) {
      todayCount++;
    }

    if ((item.severity === 'grave' || item.severity === 'obito') &&
      (item.status === 'backlog' || item.status === 'doing')) {
      criticalActive++;
    }
  });

  document.getElementById('metric-open').innerText = openCount;
  document.getElementById('metric-ontrack').innerText = onTrack;
  document.getElementById('metric-ontrack-sub').innerText = `${onTrack} dentro / ${expired} vencidos`;
  document.getElementById('metric-today').innerText = todayCount;
  document.getElementById('metric-critical').innerText = criticalActive;
}

function createCardElement(key, item) {
  const div = document.createElement('div');
  div.className = 'k-card';
  div.draggable = true;
  div.id = key;

  div.ondragstart = (ev) => ev.dataTransfer.setData("text", key);
  div.onclick = () => openDetailModal(key, item);

  // Badge de gravidade
  let badgeClass = 'bg-leve';
  if (item.severity === 'grave' || item.severity === 'obito') badgeClass = 'bg-grave';
  if (item.severity === 'moderado') badgeClass = 'bg-moderado';

  const severityLabel = SEVERITY_LABELS[item.severity] || (item.severity || '').replace('_', ' ');

  // SLA ONA
  const ona = getOnaDeadline(item.severity, item.date);
  let slaClass = 'sla-ok';
  let slaText = ona.daysLeft < 0 ? 'Vencido' : `D-${ona.daysLeft}`;
  if (ona.daysLeft < 0) slaClass = 'sla-expired';
  else if (ona.daysLeft <= 2) slaClass = 'sla-risk';

  const slaBadge = `<span class="sla-pill ${slaClass}" title="Prazo ONA: ${ona.date}">${slaText}</span>`;

  // PDCA stage
  const stage = item.pdca?.stage || 'plan';
  const stageLabel = PDCA_LABELS[stage] || 'Plan';
  const pdcaBadge = `<span class="pdca-pill pdca-pill-${stage}">${stageLabel}</span>`;

  // Unidade
  const unitLine = item.unit
    ? `<div class="card-meta"><i class="ph-bold ph-buildings"></i>${item.unit}</div>`
    : '';

  const createdBy = item.owner || item.createdBy || '';
  const ownerInitial = createdBy ? createdBy[0].toUpperCase() : '?';

  const desc = (item.desc || '').length > 90
    ? item.desc.substring(0, 90) + '…'
    : (item.desc || '');

  div.innerHTML = `
    <div class="card-line-top">
        <span class="card-title">${item.title || 'Sem título'}</span>
        ${slaBadge}
    </div>
    ${unitLine}
    <div class="card-desc">${desc}</div>
    <div class="card-footer">
        <div class="card-footer-left">
            <span class="badge ${badgeClass}">${severityLabel}</span>
            ${pdcaBadge}
        </div>
        <div class="card-footer-right">
            <span class="card-date">${formatShortDate(item.date)}</span>
            <span class="card-owner">${ownerInitial}</span>
        </div>
    </div>
  `;
  return div;
}

// Drag & Drop
window.allowDrop = (ev) => ev.preventDefault();
window.drop = (ev) => {
  ev.preventDefault();
  const cardId = ev.dataTransfer.getData("text");
  let target = ev.target;
  while (target && !target.classList.contains('column')) {
    target = target.parentElement;
  }
  if (!target) return;

  const newStatus = target.id.replace('col-', '');
  update(ref(db, `events/${cardId}`), { status: newStatus });
};

// ---------- Modais e Ferramentas ----------

window.openModal = (id) => {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
};
window.closeModal = (id) => {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
};

window.openDetailModal = (key, item) => {
  currentCardId = key;
  const modal = document.getElementById('modal-detail');
  modal.classList.remove('hidden');

  // Preenche dados
  document.getElementById('detail-title').innerText = item.title || 'Sem título';
  document.getElementById('detail-desc').innerText = item.desc || '-';
  document.getElementById('detail-date').innerText = item.date
    ? new Date(item.date).toLocaleDateString('pt-BR')
    : '-';
  document.getElementById('detail-severity').innerText =
    (SEVERITY_LABELS[item.severity] || item.severity || '-').toUpperCase();

  // Ishikawa: efeito é o título
  const effectTitle = document.getElementById('ishikawa-effect-title');
  if (effectTitle) {
    effectTitle.textContent = item.title || 'Evento';
  }

  // Calcula insight ONA
  const ona = getOnaDeadline(item.severity, item.date);
  const badge = document.getElementById('ona-status-badge');
  badge.innerText = ona.label;

  badge.classList.remove('vencido', 'atencao');
  if (ona.daysLeft < 0) {
    badge.classList.add('vencido');
  } else if (ona.daysLeft <= 2) {
    badge.classList.add('atencao');
  }

  document.getElementById('ona-prazo-text').innerText =
    `Prazo limite: ${ona.date} (${ona.daysLeft < 0 ? 'vencido' : ona.daysLeft + ' dias restantes'})`;

  // Carrega ferramentas
  loadTools(key);
  switchTab('overview');
};

window.switchTab = (tabId) => {
  document.querySelectorAll('.tab-view').forEach(el => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const view = document.getElementById(`view-${tabId}`);
  if (view) {
    view.classList.add('active');
    view.classList.remove('hidden');
  }

  document.querySelectorAll('.tool-nav button').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`tab-btn-${tabId}`);
  if (btn) btn.classList.add('active');
};

function loadTools(cardId) {
  // 5W2H
  onValue(ref(db, `events/${cardId}/5w2h`), (snap) => {
    const list = document.getElementById('5w2h-list');
    if (!list) return;
    list.innerHTML = '';
    const data = snap.val() || {};

    Object.values(data).forEach(action => {
      const when = action.when ? new Date(action.when).toLocaleDateString('pt-BR') : '-';
      const card = document.createElement('div');
      card.className = 'w2-card';

      card.innerHTML = `
        <div class="w2-header">
          <strong>${action.what || 'Ação'}</strong>
          <span class="w2-status">${action.status || ''}</span>
        </div>
        <div class="w2-tags">
          ${action.who ? `<span class="w2-tag">Quem: ${action.who}</span>` : ''}
          ${action.why ? `<span class="w2-tag">Por quê: ${action.why}</span>` : ''}
          ${action.where ? `<span class="w2-tag">Onde: ${action.where}</span>` : ''}
          ${action.when ? `<span class="w2-tag">Quando: ${when}</span>` : ''}
          ${action.howmuch ? `<span class="w2-tag">Custo: ${action.howmuch}</span>` : ''}
        </div>
        ${action.how ? `<div style="margin-top:4px;">${action.how}</div>` : ''}
      `;

      list.appendChild(card);
    });
  });

  // Ishikawa
  onValue(ref(db, `events/${cardId}/ishikawa`), (snap) => {
    const list = document.getElementById('ishikawa-list');
    if (!list) return;
    list.innerHTML = '';
    const data = snap.val() || {};

    const grouped = {};
    Object.values(data).forEach(cause => {
      const cat = cause.cat || 'Outros';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(cause);
    });

    Object.entries(grouped).forEach(([cat, causes]) => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'ishikawa-group';

      const titleDiv = document.createElement('div');
      titleDiv.className = 'ishikawa-group-title';
      titleDiv.textContent = cat;
      groupDiv.appendChild(titleDiv);

      causes.forEach(cause => {
        const causeDiv = document.createElement('div');
        causeDiv.className = 'ishikawa-cause';
        causeDiv.textContent = `• ${cause.text}`;
        groupDiv.appendChild(causeDiv);
      });

      list.appendChild(groupDiv);
    });
  });

  // PDCA
  onValue(ref(db, `events/${cardId}/pdca`), (snap) => {
    const pdca = snap.val() || {};
    document.getElementById('pdca-plan').value = pdca.plan || '';
    document.getElementById('pdca-do').value = pdca.do || '';
    document.getElementById('pdca-check').value = pdca.check || '';
    document.getElementById('pdca-act').value = pdca.act || '';
    setPdcaStage(pdca.stage || 'plan');
  });
}

// ---------- 5W2H (inline form) ----------

window.add5W2H = () => {
  const form = document.getElementById('5w2h-form');
  if (form) {
    form.classList.remove('hidden');
  }
};

window.cancel5W2H = () => {
  const form = document.getElementById('5w2h-form');
  if (form) {
    form.classList.add('hidden');
  }
};

window.confirm5W2H = () => {
  if (!currentCardId) return;

  const what = document.getElementById('w2-what').value.trim();
  const who = document.getElementById('w2-who').value.trim();
  const why = document.getElementById('w2-why').value.trim();
  const where = document.getElementById('w2-where').value.trim();
  const when = document.getElementById('w2-when').value;
  const how = document.getElementById('w2-how').value.trim();
  const howmuch = document.getElementById('w2-howmuch').value.trim();

  if (!what) {
    showToast("Descreva o que será feito (What).", "warning");
    return;
  }

  push(ref(db, `events/${currentCardId}/5w2h`), {
    what,
    who,
    why,
    where,
    when,
    how,
    howmuch,
    createdBy: currentUser?.email || null,
    createdAt: new Date().toISOString(),
    status: "Planejado"
  });

  // limpa campos
  ['w2-what', 'w2-who', 'w2-why', 'w2-where', 'w2-when', 'w2-how', 'w2-howmuch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const form = document.getElementById('5w2h-form');
  if (form) form.classList.add('hidden');

  showToast("Ação 5W2H adicionada.");
};

// ---------- Ishikawa (inline form) ----------

window.addIshikawa = () => {
  const form = document.getElementById('ishikawa-form');
  if (form) {
    form.classList.remove('hidden');
    const input = document.getElementById('ishikawa-text');
    if (input) input.focus();
  }
};

window.cancelIshikawa = () => {
  const form = document.getElementById('ishikawa-form');
  if (form) form.classList.add('hidden');
};

window.confirmIshikawa = () => {
  if (!currentCardId) return;
  const cat = document.getElementById('ishikawa-cat').value;
  const text = document.getElementById('ishikawa-text').value.trim();

  if (!text) {
    showToast("Descreva a causa para adicioná-la ao diagrama.", "warning");
    return;
  }

  push(ref(db, `events/${currentCardId}/ishikawa`), {
    cat,
    text,
    createdBy: currentUser?.email || null,
    createdAt: new Date().toISOString()
  });

  document.getElementById('ishikawa-text').value = '';
  const form = document.getElementById('ishikawa-form');
  if (form) form.classList.add('hidden');
  showToast("Causa adicionada ao Ishikawa.");
};

// ---------- PDCA ----------

function setPdcaStage(stage) {
  currentPdcaStage = stage || 'plan';

  const labelMap = {
    plan: 'Planejar',
    do: 'Executar',
    check: 'Checar',
    act: 'Agir'
  };

  const labelEl = document.getElementById('pdca-current-label');
  if (labelEl) labelEl.textContent = labelMap[currentPdcaStage] || 'Selecione a fase';

  // Chips
  document.querySelectorAll('.pdca-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.stage === currentPdcaStage);
  });

  // Form de cada fase
  document.querySelectorAll('.pdca-stage-form').forEach(form => {
    const stageForm = form.dataset.stage;
    form.classList.toggle('active', stageForm === currentPdcaStage);
  });

  // Segmentos visuais
  document.querySelectorAll('.pdca-segment').forEach(seg => seg.classList.remove('active'));
  const activeSeg = document.querySelector(`.pdca-segment.pdca-${currentPdcaStage}`);
  if (activeSeg) activeSeg.classList.add('active');
}

window.savePdca = async () => {
  if (!currentCardId) return;

  const plan = document.getElementById('pdca-plan').value;
  const doField = document.getElementById('pdca-do').value;
  const check = document.getElementById('pdca-check').value;
  const act = document.getElementById('pdca-act').value;

  const data = {
    stage: currentPdcaStage,
    plan,
    do: doField,
    check,
    act,
    updatedBy: currentUser?.email || null,
    updatedAt: new Date().toISOString()
  };

  try {
    await update(ref(db, `events/${currentCardId}`), { pdca: data });
    showToast("PDCA salvo com sucesso.");
  } catch (err) {
    console.error(err);
    showToast("Erro ao salvar PDCA.", "error");
  }
};

window.resetPdca = () => {
  ['pdca-plan', 'pdca-do', 'pdca-check', 'pdca-act'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  setPdcaStage('plan');
};

// ---------- Novo Evento ----------

document.getElementById('new-event-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const title = document.getElementById('new-title').value.trim();
  const date = document.getElementById('new-date').value;
  const severity = document.getElementById('new-severity').value;
  const desc = document.getElementById('new-desc').value.trim();
  const unit = document.getElementById('new-unit').value.trim();
  const owner = document.getElementById('new-owner').value.trim() || currentUser.email.split('@')[0];

  if (!title || !date || !severity) {
    showToast("Preencha pelo menos título, data e gravidade.", "warning");
    return;
  }

  push(ref(db, 'events'), {
    title,
    date,
    severity,
    desc,
    unit,
    owner,
    status: 'backlog',
    createdBy: currentUser.email,
    createdAt: new Date().toISOString()
  });

  closeModal('modal-new');
  e.target.reset();
  showToast("Evento criado no Kanban.");
});
