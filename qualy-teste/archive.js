// archive.js
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  ref,
  onValue,
  get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const { jsPDF } = window.jspdf;

const SEVERITY_LABELS = {
  sem_dano: "Evento sem dano",
  leve: "Dano leve",
  moderado: "Dano moderado",
  grave: "Dano grave",
  obito: "Óbito",
  near_miss: "Near miss",
  nao_classificado: "Não classificado"
};

let currentUser = null;
let archiveEvents = {};
let archiveFilterSeverity = 'all';
let archiveSearchTerm = '';

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

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html?next=archive.html";
    return;
  }
  currentUser = user;
  const usersSnap = await get(ref(db, `users/${user.uid}`));
  const profile = usersSnap.val() || {};
  const name = profile.name || (user.email ? user.email.split("@")[0] : "Usuário");
  const color = profile.color || "#276b38";

  document.documentElement.style.setProperty('--accent', color);

  const avatar = document.getElementById("user-avatar");
  const nameSpan = document.getElementById("user-name");
  if (avatar) {
    avatar.style.backgroundColor = color;
    avatar.textContent = (name || '?')[0].toUpperCase();
  }
  if (nameSpan) nameSpan.textContent = name;

  initArchive();
});

function initArchive() {
  const searchInput = document.getElementById('archive-search');
  searchInput.addEventListener('input', (e) => {
    archiveSearchTerm = e.target.value.toLowerCase();
    renderArchive();
  });

  document.querySelectorAll('.chip-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      archiveFilterSeverity = btn.dataset.severity || 'all';
      renderArchive();
    });
  });

  // 1) Arquivo principal (eventos marcados como archived)
  onValue(ref(db, 'events'), (snap) => {
    const all = snap.val() || {};
    archiveEvents = {};
    Object.entries(all).forEach(([id, ev]) => {
      if (ev && ev.archived) archiveEvents[id] = ev;
    });
    renderArchive();
  });

  // 2) Compat: bases antigas que moviam para /archives
  onValue(ref(db, 'archives'), (snap) => {
    const legacy = snap.val() || {};
    // Mescla apenas se ainda não existir em /events
    Object.entries(legacy).forEach(([id, ev]) => {
      if (ev && !archiveEvents[id]) archiveEvents[id] = ev;
    });
    renderArchive();
  });
}

function passesArchiveFilter(ev) {
  if (!ev) return false;

  const isEvento = (ev.type || 'evento') === 'evento';

  if (archiveFilterSeverity === 'all') {
    // ok pra tudo
  } else {
    if (!isEvento) return false; // tarefas/projetos só aparecem no filtro "Todos"
    if (archiveFilterSeverity === 'grave') {
      if (ev.severity !== 'grave' && ev.severity !== 'obito') return false;
    } else if (archiveFilterSeverity === 'moderado') {
      if (ev.severity !== 'moderado') return false;
    } else if (archiveFilterSeverity === 'leve') {
      if (!['leve','sem_dano','near_miss'].includes(ev.severity)) return false;
    }
  }

  if (archiveSearchTerm) {
    const text = `${ev.title || ''} ${ev.desc || ''} ${ev.unit || ''}`.toLowerCase();
    if (!text.includes(archiveSearchTerm)) return false;
  }

  return true;
}

function renderArchive() {
  const list = document.getElementById("archive-list");
  list.innerHTML = "";

  const entries = Object.entries(archiveEvents)
    .filter(([, ev]) => passesArchiveFilter(ev))
    .sort(([, a], [, b]) => {
      const da = a.archivedAt || a.createdAt || '';
      const dbv = b.archivedAt || b.createdAt || '';
      return (dbv || '').localeCompare(da || '');
    });

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.textContent = "Nenhum card arquivado com esse filtro.";
    empty.style.fontSize = "13px";
    empty.style.color = "#999";
    list.appendChild(empty);
    return;
  }

  entries.forEach(([id, ev]) => {
    const card = document.createElement("div");
    card.className = "archive-card";

    const sevLabel = SEVERITY_LABELS[ev.severity] || ev.severity || "-";
    const dateStr = ev.date ? new Date(ev.date).toLocaleDateString('pt-BR') : "-";
    const archStr = ev.archivedAt ? new Date(ev.archivedAt).toLocaleString('pt-BR') : "-";

    const isEvento = (ev.type || 'evento') === 'evento';
    const badgeClass =
      !isEvento ? 'bg-leve' :
      ev.severity === 'grave' || ev.severity === 'obito' ? 'bg-grave' :
      ev.severity === 'moderado' ? 'bg-moderado' : 'bg-leve';

    const typeLabel =
      ev.type === 'tarefa' ? 'Tarefa' :
      ev.type === 'projeto' ? 'Projeto' : 'Evento';

    card.innerHTML = `
      <div class="archive-header">
        <div class="archive-title">${ev.title || 'Sem título'} (${typeLabel})</div>
        <span class="badge ${badgeClass}">
          ${sevLabel}
        </span>
      </div>
      <div class="archive-meta">
        <span>Data: ${dateStr}</span> ·
        <span>Unidade: ${ev.unit || '-'}</span> ·
        <span>Arquivado em: ${archStr}</span>
      </div>
      <div class="archive-actions">
        <button class="btn-tertiary small" data-id="${id}" data-action="view">
          <i class="ph-bold ph-eye"></i> Visualizar resumo
        </button>
        <button class="btn-primary small" data-id="${id}" data-action="pdf">
          <i class="ph-bold ph-file-pdf"></i> Baixar PDF
        </button>
      </div>
    `;

    list.appendChild(card);
  });

  list.querySelectorAll("button[data-action='pdf']").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      downloadPdf(id);
    });
  });

  list.querySelectorAll("button[data-action='view']").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const ev = archiveEvents[id];
      if (!ev) return;
      const preview = [
        `Título: ${ev.title || '-'}`,
        `Tipo: ${ev.type || 'evento'}`,
        `Unidade: ${ev.unit || '-'}`,
        `Data: ${ev.date ? new Date(ev.date).toLocaleDateString('pt-BR') : '-'}`,
        `Gravidade: ${SEVERITY_LABELS[ev.severity] || ev.severity || '-'}`,
        ``,
        `Descrição:`,
        ev.desc || '-'
      ].join('\n');
      alert(preview);
    });
  });
}

async function downloadPdf(id) {
  // Tenta em /events e, se não existir, tenta /archives (compat)
  let snap = await get(ref(db, `events/${id}`));
  let ev = snap.val();
  if (!ev) {
    snap = await get(ref(db, `archives/${id}`));
    ev = snap.val();
  }
  if (!ev) {
    showToast("Evento não encontrado.", "error");
    return;
  }

  const isEvento = (ev.type || 'evento') === 'evento';

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = 15;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(isEvento ? "ANÁLISE DE EVENTO (PCT)" : "RELATÓRIO DO CARD", 105, y, { align: "center" });
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  const typeLabel =
    ev.type === 'tarefa' ? 'Tarefa' :
    ev.type === 'projeto' ? 'Projeto' : 'Evento';

  const dEvento = ev.date ? new Date(ev.date).toLocaleDateString('pt-BR') : '-';
  const dNotif = ev.notificationDate
    ? new Date(ev.notificationDate).toLocaleDateString('pt-BR')
    : (ev.createdAt ? new Date(ev.createdAt).toLocaleDateString('pt-BR') : '-');

  // Cabeçalho do card
  doc.text(`Título: ${ev.title || '-'}`, 15, y); y += 5;
  doc.text(`Tipo: ${typeLabel}`, 15, y); y += 5;
  doc.text(`Unidade: ${ev.unit || '-'}`, 15, y); y += 5;
  doc.text(`Data: ${dEvento}`, 15, y); y += 7;

  // Sequência PCT (apenas para eventos)
  if (isEvento) {
    const grav = SEVERITY_LABELS[ev.severity] || ev.severity || "-";

    const addSectionTitle = (title) => {
      if (y > 275) { doc.addPage(); y = 15; }
      doc.setFont("helvetica", "bold");
      doc.text(title, 15, y);
      y += 5;
      doc.setFont("helvetica", "normal");
    };

    const addParagraph = (text) => {
      const content = (text && String(text).trim()) ? String(text).trim() : "-";
      const lines = doc.splitTextToSize(content, 180);
      doc.text(lines, 15, y);
      y += lines.length * 4 + 2;
    };

    addSectionTitle("DADOS DO PACIENTE");
    doc.text(`Nome: ${ev.patientName || '-'}`, 15, y); y += 5;
    const dob = ev.patientDob ? new Date(ev.patientDob).toLocaleDateString('pt-BR') : '-';
    doc.text(`Data de nascimento: ${dob}`, 15, y); y += 7;

    addSectionTitle(`DADOS DO EVENTO N° ${ev.eventCode || '-'}`);
    doc.text(`Data do evento: ${dEvento}`, 15, y); y += 5;
    doc.text(`Data da notificação: ${dNotif}`, 15, y); y += 5;
    doc.text(`Unidade: ${ev.unit || '-'}`, 15, y); y += 5;
    doc.text(`Gravidade (ONA): ${grav}`, 15, y); y += 7;

    const system = ev.notificationSystem || 'Docnix';
    addSectionTitle(`NOTIFICAÇÃO – SISTEMA ${system}`);
    addParagraph(ev.notificationText || ev.desc);

    addSectionTitle("CRONOLOGIA DO EVENTO");
    addParagraph(ev.chronologyText);

    addSectionTitle("DESFECHO PARA O PACIENTE");
    addParagraph(ev.outcomeText);

    addSectionTitle("ENTREVISTA");
    addParagraph(ev.interviewText);

    addSectionTitle("DADOS DA ANÁLISE (TIME DE INVESTIGAÇÃO)");
    addParagraph(ev.investigationTeam);

    addSectionTitle("CONCLUSÃO DO GERENCIAMENTO DE RISCOS");
    addParagraph(ev.conclusionText);
  } else {
    // Para tarefa/projeto, mantém um resumo simples
    doc.setFont("helvetica", "bold");
    doc.text("Descrição / Resumo", 15, y); y += 5;
    doc.setFont("helvetica", "normal");
    const desc = ev.desc || "-";
    const descLines = doc.splitTextToSize(desc, 180);
    doc.text(descLines, 15, y);
    y += descLines.length * 4 + 6;
  }

  // Ferramentas (sempre que existirem)
  const ishSnap = await get(ref(db, `events/${id}/ishikawa`));
  const ish = ishSnap.val() || {};
  const rootId = ev.ishikawaRootId || null;

  doc.setFont("helvetica", "bold");
  doc.text("Análise de causa (Ishikawa - 6M)", 15, y); y += 5;
  doc.setFont("helvetica", "normal");

  const grouped = {};
  Object.entries(ish).forEach(([cid, c]) => {
    const cat = c.cat || "Outros";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ id: cid, ...c });
  });

  Object.entries(grouped).forEach(([cat, causes]) => {
    if (y > 270) { doc.addPage(); y = 15; }
    doc.setFont("helvetica", "bold");
    doc.text(`• ${cat}`, 15, y); y += 4;
    doc.setFont("helvetica", "normal");
    causes.forEach(c => {
      const mark = rootId && rootId === c.id ? "[CAUSA RAIZ] " : "- ";
      const line = `${mark}${c.text || ''}`;
      const lines = doc.splitTextToSize(line, 175);
      doc.text(lines, 20, y);
      y += lines.length * 4;
    });
    y += 2;
  });

  // HFMEA / FMEA
  const fmeaSnap = await get(ref(db, `events/${id}/fmea`));
  const fmea = fmeaSnap.val() || {};
  const fmeaEntries = Object.values(fmea);
  if (fmeaEntries.length) {
    if (y > 260) { doc.addPage(); y = 15; }
    doc.setFont("helvetica", "bold");
    doc.text("Análise de falhas (HFMEA / FMEA)", 15, y); y += 5;
    doc.setFont("helvetica", "normal");

    // Ordena por hazardScore (HFMEA) ou RPN (FMEA tradicional)
    fmeaEntries
      .sort((a, b) => {
        const sa = (a.hazardScore ?? a.rpn ?? 0);
        const sb = (b.hazardScore ?? b.rpn ?? 0);
        return sb - sa;
      })
      .slice(0, 12)
      .forEach((row, idx) => {
        if (y > 270) { doc.addPage(); y = 15; }
        const score = row.hazardScore ?? row.rpn ?? '-';
        const method = (row.hazardScore !== undefined) ? 'HFMEA' : 'RPN';
        doc.setFont("helvetica", "bold");
        doc.text(`${idx + 1}. ${row.step || 'Etapa'}  (${method}: ${score})`, 15, y);
        y += 4;
        doc.setFont("helvetica", "normal");

        const parts = [
          `Modo de falha: ${row.failureMode || '-'}`,
          `Causa: ${row.cause || '-'}`,
          `Efeito: ${row.effect || '-'}`,
          `Controles: ${row.controls || '-'}`,
          `Ação: ${row.action || '-'}`,
          `Responsável: ${row.owner || '-'}`,
          `Prazo: ${row.due ? new Date(row.due).toLocaleDateString('pt-BR') : '-'}`
        ];
        const lines = doc.splitTextToSize(parts.join("\n"), 180);
        doc.text(lines, 15, y);
        y += lines.length * 4 + 4;
      });
  }

  const wSnap = await get(ref(db, `events/${id}/5w2h`));
  const w2 = wSnap.val() || {};
  if (y > 260) { doc.addPage(); y = 15; }
  doc.setFont("helvetica", "bold");
  doc.text("Plano de ação (5W2H)", 15, y); y += 5;
  doc.setFont("helvetica", "normal");

  Object.values(w2).forEach((a, idx) => {
    if (y > 270) { doc.addPage(); y = 15; }
    doc.text(`${idx + 1}. O que (What): ${a.what || '-'}`, 15, y); y += 4;
    doc.text(`   Por quê (Why): ${a.why || '-'}`, 15, y); y += 4;
    doc.text(`   Quem (Who): ${a.who || '-'}`, 15, y); y += 4;
    doc.text(`   Onde (Where): ${a.where || '-'}`, 15, y); y += 4;
    const dataWhen = a.when ? new Date(a.when).toLocaleDateString('pt-BR') : '-';
    doc.text(`   Quando (When): ${dataWhen}`, 15, y); y += 4;
    doc.text(`   Como (How):`, 15, y); y += 4;
    const howLines = doc.splitTextToSize(a.how || '-', 175);
    doc.text(howLines, 20, y); y += howLines.length * 4;
    doc.text(`   Custo (How much): ${a.howmuch || '-'}`, 15, y); y += 5;
  });

  const pdcaSnap = await get(ref(db, `events/${id}/pdca`));
  const pdca = pdcaSnap.val() || {};
  if (y > 260) { doc.addPage(); y = 15; }
  doc.setFont("helvetica", "bold");
  doc.text("Ciclo PDCA do caso", 15, y); y += 5;
  doc.setFont("helvetica", "normal");

  function addPdcaBlock(title, text) {
    if (y > 270) { doc.addPage(); y = 15; }
    doc.setFont("helvetica", "bold");
    doc.text(title, 15, y); y += 4;
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(text || "-", 175);
    doc.text(lines, 20, y); y += lines.length * 4 + 2;
  }

  addPdcaBlock("P - Planejar", pdca.plan);
  addPdcaBlock("D - Executar", pdca.do);
  addPdcaBlock("C - Checar", pdca.check);
  addPdcaBlock("A - Agir", pdca.act);

  const fileName = `Analise_${(ev.title || 'evento').substring(0,40).replace(/\s+/g,'_')}.pdf`;
  doc.save(fileName);
  showToast("PDF gerado com sucesso.");
}
