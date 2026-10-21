/* =============================================================================
   ARVORECER — LÓGICA DA PÁGINA (app.js)
   -----------------------------------------------------------------------------
   Este arquivo controla TUDO o que acontece no navegador. Índice:

     0. Constantes e estado
     1. Funções utilitárias
     2. Tema claro/escuro
     3. Navegação e troca de modo
     4. Dados do servidor (tabela de competências/pesos, contador público)
     5. TESTE DE INTERPRETAÇÃO — N1 a N4  (antigo "autônomo": sorteio, questões, envio)
     6. TESTE FUNDAMENTAL — N0  (antigo "modo professor": itens um a um, registro oral, montagem de frases, envio)
     7. Envio ao servidor (comum aos dois modos)
     8. Resultado
     9. Inicialização

   IMPORTANTE: o navegador NÃO conhece o gabarito. Ele só envia as respostas para
   /api/save_result (função serverless), que calcula a nota (com os pesos por competência), grava no
   banco e devolve o resultado para ser exibido aqui.

   Dependências carregadas antes (ver index.html):
     QUESTION_BANK, SHORT_FORM_GROUPS  -> assets/questions.js
     MEDIATED_ITEMS                    -> assets/mediated.js
   ============================================================================= */
"use strict";

/* =============================================================================
   0. CONSTANTES E ESTADO
   ============================================================================= */

// Endereços dos scripts PHP (relativos à página)
const URL_SAVE = "/api/save_result";
const URL_COUNT = "/api/respondentes";
const URL_WEIGHTS = "/api/weights";

/* Distribuição nacional usada como referência no resultado do Teste de Interpretação.
   Fonte informada na versão original da página: INAF Brasil 2024 (Ação Educativa / UNICEF).
   >>> Confira os percentuais na fonte oficial antes de divulgar. */
const INAF_2024 = [
  { name: "Analfabeto",    pct: 7,  color: "#c4572f" },
  { name: "Rudimentar",    pct: 22, color: "#e8962e" },
  { name: "Elementar",     pct: 36, color: "#c9b02a" },
  { name: "Intermediário", pct: 25, color: "#4a9d5f" },
  { name: "Proficiente",   pct: 10, color: "#1f7a4d" }
];

/* Estado global da página (tudo o que muda durante o uso fica aqui). */
const state = {
  mode: "autonomo",        // teste ativo na aba: "autonomo" (Interpretação N1–N4) | "mediado" (Fundamental N0)
  weights: null,           // resposta de /api/weights: {levels, competencies} (null enquanto não carregou)
  compOpen: false,         // tabela de competências está exibida?
  startTime: null,         // Date.now() do início do teste (para medir duração)
  submitting: false,       // evita duplo clique em "enviar"
  lastPayload: null,       // último envio (permite "tentar salvar de novo")
  // --- Teste de Interpretação (N1–N4) ---
  questions: [],           // questões sorteadas (com alternativas embaralhadas)
  selectedTotal: 30,
  // --- Teste Fundamental (N0) ---
  med: { items: [], responses: {}, builds: {}, index: 0, notes: "" }
};

/* =============================================================================
   1. FUNÇÕES UTILITÁRIAS
   ============================================================================= */

const $ = (id) => document.getElementById(id);

/** Número inteiro aleatório de 0 a max-1. */
function randInt(max) { return Math.floor(Math.random() * max); }

/** Embaralha uma lista (Fisher–Yates) sem alterar a original. */
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Escapa texto para colocar com segurança dentro de HTML. */
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
/** Formata número no padrão brasileiro (vírgula decimal). */
function fmt(n) { return nf.format(n); }

/** 125 -> "2 min 5 s". */
function fmtDuration(sec) {
  if (!sec || sec < 1) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

/** Duração desde o início do teste, em segundos. */
function elapsedSeconds() {
  return state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0;
}

/** Rola suavemente até a seção com o id informado. */
function scrollToSection(id) {
  const el = $(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Mostra/oculta uma seção usando a classe .hidden. */
function show(id, visible) { $(id).classList.toggle("hidden", !visible); }


/* =============================================================================
   2. TEMA CLARO / ESCURO
   ============================================================================= */

/** Aplica e salva o tema; atualiza o rótulo do botão. */
function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("arvorecer-theme", next); } catch (e) { /* ignora */ }
  const button = $("themeToggle");
  button.textContent = next === "dark" ? "☀️ Claro" : "🌙 Escuro";
  button.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
}

function initThemeToggle() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  $("themeToggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

/* =============================================================================
   3. NAVEGAÇÃO E TROCA DE MODO
   ============================================================================= */

/** Seleciona a aba (Interpretação = "autonomo" ou Fundamental = "mediado") e mostra o formulário correspondente. */
function setMode(mode) {
  state.mode = mode === "mediado" ? "mediado" : "autonomo";
  const auto = state.mode === "autonomo";
  $("tabAutonomo").classList.toggle("is-on", auto);
  $("tabMediado").classList.toggle("is-on", !auto);
  $("tabAutonomo").setAttribute("aria-selected", auto);
  $("tabMediado").setAttribute("aria-selected", !auto);
  show("formAutonomo", auto);
  show("formMediado", !auto);
}

/** Liga os cliques de navegação por delegação (um único ouvinte para a página toda). */
function initNavigation() {
  document.addEventListener("click", (event) => {
    // Links/botões que rolam até uma seção: data-scroll="id"
    const scroller = event.target.closest("[data-scroll]");
    if (scroller) {
      event.preventDefault();
      scrollToSection(scroller.dataset.scroll);
      return;
    }
    // Cartões de modo e abas: data-mode="autonomo|mediado"
    const modeBtn = event.target.closest("[data-mode]");
    if (modeBtn) {
      setMode(modeBtn.dataset.mode);
      if (!modeBtn.classList.contains("tab")) scrollToSection("comecar");
      return;
    }
  });
}

/* =============================================================================
   4. DADOS DO SERVIDOR (pesos, faixas, contador público)
   ============================================================================= */

/** Texto curto de "onde a competência é usada no cálculo". */
function usageLabel(c) {
  if (!c.applied) return `<span class="use use-none">fora deste teste</span>`;
  return c.test === "fundamental"
    ? `<span class="use use-fund">Teste Fundamental</span>`
    : `<span class="use use-interp">Teste de Interpretação</span>`;
}

/** Desenha a TABELA ÚNICA (N0 a N4 mesclados), com o peso de cada competência.
    Os níveis só separam as linhas; quem diferencia os testes é o cálculo no servidor
    (Fundamental usa só N0; Interpretação usa N1 a N4). */
function renderCompetencyTable() {
  const box = $("competencyGrid");
  const data = state.weights;
  if (!data) {
    box.innerHTML = `<p class="muted">Não foi possível carregar a tabela (/api/weights). Recarregue a página ou tente de novo em instantes.</p>`;
    return;
  }
  const maxW = Math.max(...data.competencies.map((c) => c.weight), 1);
  let rows = "";
  data.levels.forEach((lv) => {
    rows += `<tr class="lv-row"><th colspan="4">${esc(lv.code)} — ${esc(lv.name)}<span>${esc(lv.desc)}</span></th></tr>`;
    data.competencies.filter((c) => c.level === lv.code).forEach((c) => {
      rows += `<tr class="${c.applied ? "" : "is-off"}">
        <td class="c-code">${esc(c.code)}</td>
        <td class="c-name"><strong>${esc(c.title)}</strong><span>${esc(c.desc)}</span></td>
        <td class="c-use">${usageLabel(c)}</td>
        <td class="c-w"><span class="weight" title="Peso ${fmt(c.weight)}"><i style="--w:${(c.weight / maxW) * 100}%"></i>${fmt(c.weight)}</span></td>
      </tr>`;
    });
  });
  box.innerHTML = `
    <p class="muted small">Peso de cada competência = peso do seu nível. No cálculo, o Teste Fundamental usa só o nível N0 e o
      Teste de Interpretação usa N1 a N4. <code>score = soma dos pesos dos acertos ÷ soma dos pesos de todas as questões × 100</code>.</p>
    <div class="comp-table-scroll"><table class="comp-table">
      <thead><tr><th>Código</th><th>Competência</th><th>Usada em</th><th>Peso</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/** Botão "Exibir competências" / "Ocultar competências". */
function toggleCompetencies() {
  state.compOpen = !state.compOpen;
  const btn = $("btnToggleComp");
  btn.textContent = state.compOpen ? "Ocultar competências" : "Exibir competências";
  btn.classList.toggle("is-on", state.compOpen);
  btn.setAttribute("aria-expanded", state.compOpen);
  show("competencyGrid", state.compOpen);
  if (state.compOpen) renderCompetencyTable();
}

/** Busca a tabela de competências e pesos em /api/weights (fonte única: lib/config.js). */
async function loadWeights() {
  try {
    const response = await fetch(URL_WEIGHTS, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("resposta inválida");
    state.weights = data;
  } catch (e) {
    state.weights = null;
  }
  if (state.compOpen) renderCompetencyTable();
}

/** Atualiza o contador público de avaliações na página inicial. */
function updateResponseCountDisplays(count) {
  if (!Number.isInteger(count)) return;
  $("heroResponseCountValue").textContent = new Intl.NumberFormat("pt-BR").format(count);
}

async function loadPublicResponseCount() {
  try {
    const response = await fetch(URL_COUNT, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok || !Number.isInteger(data.responseCount)) throw new Error("inválido");
    updateResponseCountDisplays(data.responseCount);
  } catch (e) {
    $("heroResponseCountValue").textContent = "—";
  }
}

/* =============================================================================
   5. TESTE AUTÔNOMO
   ============================================================================= */

/** Tamanho escolhido no formulário: 30 (padrão) ou 50 questões. */
function getSelectedTotal() {
  return parseInt($("testLength").value, 10) === 50 ? 50 : 30;
}

/** Sorteia 1 variante (entre 10) para cada grupo do teste e embaralha as alternativas. */
function selectQuestions() {
  state.selectedTotal = getSelectedTotal();
  const groupIndexes = state.selectedTotal === 50 ? QUESTION_BANK.map((_, i) => i) : SHORT_FORM_GROUPS;
  state.questions = groupIndexes.map((groupIndex) => {
    const group = QUESTION_BANK[groupIndex];
    const q = group[randInt(group.length)];
    return { ...q, groupIndex, o: shuffle(q.o) };
  });
}

/** Desenha todas as questões do teste autônomo no formulário #quizForm. */
function renderQuiz() {
  $("quizForm").innerHTML = state.questions.map((item, i) => `
    <article class="question" id="q${i}">
      <div class="q-head"><div class="qnum">${i + 1}</div><strong>Questão ${i + 1}</strong></div>
      <div class="stimulus">${item.s}</div>
      <p class="prompt">${item.q}</p>
      <div class="options">
        ${item.o.map((opt) => `
          <label class="option">
            <input type="radio" name="q${i}" value="${opt.id}">
            <span class="mark"></span><span>${opt.text}</span>
          </label>`).join("")}
      </div>
    </article>`).join("");
}

/** Quantas questões já têm alternativa marcada. */
function answeredCount() {
  return state.questions.filter((_, i) => document.querySelector(`input[name="q${i}"]:checked`)).length;
}

/** Atualiza barra de progresso e contador da barra de ações. */
function updateQuizProgress() {
  const total = state.questions.length || getSelectedTotal();
  const answered = answeredCount();
  $("progressFill").style.width = `${total ? (answered / total) * 100 : 0}%`;
  $("progressText").textContent = `${answered}/${total} respondidas`;
  $("quizCount").textContent = `${answered}/${total}`;
}

/** Validação dos dados do formulário autônomo. Retorna true se tudo está preenchido. */
function validateAutonomo() {
  const needed = ["ageRange", "education", "region", "arrivalSource", "testLength"];
  if (needed.some((id) => !$(id).value)) {
    alert("Preencha faixa etária, escolaridade, região, como você chegou ao teste e tamanho do teste antes de começar.");
    scrollToSection("comecar");
    return false;
  }
  if (!$("consent").checked) {
    alert("Para participar, é necessário aceitar o armazenamento anônimo dos dados.");
    scrollToSection("comecar");
    return false;
  }
  return true;
}

/** Botão “Iniciar teste” do modo autônomo. */
function startAutonomo() {
  if (!validateAutonomo()) return;
  selectQuestions();
  renderQuiz();
  state.startTime = Date.now();
  show("result", false);
  show("guided", false);
  show("quiz", true);
  $("progressWrap").style.display = "block";
  $("quizModeInfo").classList.remove("is-error");
  $("quizModeInfo").textContent = `Você escolheu responder ${state.questions.length} questões. As perguntas foram sorteadas agora; os nomes das competências só aparecem no relatório final.`;
  updateQuizProgress();
  scrollToSection("quiz");
}

/** Recomeça: sorteia novas questões (pede confirmação se já houver respostas). */
function restartQuiz() {
  if (answeredCount() > 0 && !confirm("Recomeçar apaga as respostas atuais e sorteia novas questões. Continuar?")) return;
  selectQuestions();
  renderQuiz();
  state.startTime = Date.now();
  updateQuizProgress();
  scrollToSection("quiz");
}

/** Botão “Ver meu resultado”: confere se tudo foi respondido e envia. */
async function finishQuiz() {
  if (state.submitting) return;
  const missing = [];
  state.questions.forEach((_, i) => {
    const card = $(`q${i}`);
    const done = !!document.querySelector(`input[name="q${i}"]:checked`);
    card.classList.toggle("is-missing", !done);
    if (!done) missing.push(i);
  });
  if (missing.length) {
    const info = $("quizModeInfo");
    info.classList.add("is-error");
    info.textContent = `Faltam ${missing.length} questão(ões): ${missing.slice(0, 10).map((i) => i + 1).join(", ")}${missing.length > 10 ? "…" : ""}`;
    $(`q${missing[0]}`).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const payload = {
    mode: "autonomo",
    consent: true,
    ageRange: $("ageRange").value,
    education: $("education").value,
    region: $("region").value,
    arrivalSource: $("arrivalSource").value,
    website: $("website").value,                  // honeypot
    total: state.questions.length,
    durationSeconds: elapsedSeconds(),
    questionIds: state.questions.map((q) => q.id),
    answers: state.questions.map((_, i) => document.querySelector(`input[name="q${i}"]:checked`).value)
  };
  await submitPayload(payload);
}

/** Ouvintes do teste autônomo (marcação visual das alternativas e progresso). */
function initQuizEvents() {
  $("quizForm").addEventListener("change", (event) => {
    if (!event.target.matches('input[type="radio"]')) return;
    const card = event.target.closest(".question");
    card.classList.remove("is-missing");
    card.querySelectorAll("label.option").forEach((l) => l.classList.toggle("is-checked", l.contains(event.target) && event.target.checked));
    updateQuizProgress();
  });
  $("startAutonomo").addEventListener("click", startAutonomo);
  $("btnRestartQuiz").addEventListener("click", restartQuiz);
  $("btnFinishQuiz").addEventListener("click", finishQuiz);
  $("testLength").addEventListener("change", () => {
    $("progressText").textContent = `0/${getSelectedTotal()} respondidas`;
  });
}

/* =============================================================================
   6. MODO PROFESSOR (alfabetização inicial)
   -----------------------------------------------------------------------------
   Um item por vez. Tipos de item (ver assets/mediated.js):
     choice -> o aluno toca em uma alternativa
     build  -> o aluno monta a frase tocando nas palavras na ordem
     oral   -> o professor registra: acertou / parcial / não acertou
   ============================================================================= */

/** Se o texto é um caminho de imagem (assets/..., http..., /...), devolve <img>; senão, o próprio texto. */
function isImagePath(value) { return /^(assets\/|https?:\/\/|\/)/.test(value); }

/** Desenha o ESTÍMULO grande do item (letra, palavra, figura, frase). */
function renderShow(show) {
  if (!show) return "";
  switch (show.kind) {
    case "letter":   return `<div class="show-letter">${esc(show.value)}</div>`;
    case "word":     return `<div class="show-word">${esc(show.value)}</div>`;
    case "sentence": return `<div class="show-sentence">${esc(show.value)}</div>`;
    case "image": {
      const pic = isImagePath(show.value)
        ? `<img class="show-img" src="${esc(show.value)}" alt="">`
        : `<div class="show-emoji" role="img" aria-label="figura">${esc(show.value)}</div>`;
      return pic + (show.word ? `<div class="show-blank">${esc(show.word)}</div>` : "");
    }
    default: return "";
  }
}

/** Prepara os itens: embaralha alternativas (choice) e palavras (build). */
function prepareMediated() {
  state.med = {
    items: MEDIATED_ITEMS.map((it) => ({
      ...it,
      options: it.options ? shuffle(it.options) : undefined,
      bag: it.wordBag ? shuffle(it.wordBag.map((w, i) => ({ w, k: i }))) : undefined   // k identifica cada ficha
    })),
    responses: {},   // id do item -> resposta ('a'..'d' | ['palavra',...] | 'ok'/'parcial'/'nao')
    builds: {},      // id do item -> lista de chaves k já colocadas na linha
    index: 0,
    notes: ""
  };
  $("gNotes").value = "";
}

/** Quantos itens já têm algum registro. */
function mediatedAnswered() {
  return Object.values(state.med.responses).filter((v) => v !== null && v !== undefined).length;
}

/** Desenha o item atual (palco do aluno + painel do professor + navegação). */
function renderGuided() {
  const m = state.med;
  const it = m.items[m.index];
  const n = m.items.length;

  $("gCompetency").textContent = `${it.c} · ${it.d}`;
  $("gTitle").textContent = `Item ${m.index + 1} de ${n}`;

  // ---------- palco (o que o aluno vê) ----------
  let body = "";
  if (it.type === "choice") {
    body = `<div class="choice-grid">${it.options.map((o) => {
      const picked = m.responses[it.id] === o.id ? " is-picked" : "";
      const emoji = /\p{Extended_Pictographic}/u.test(o.text) ? " is-emoji" : "";
      const inner = isImagePath(o.text) ? `<img class="show-img" src="${esc(o.text)}" alt="">` : esc(o.text);
      return `<button type="button" class="choice-btn${emoji}${picked}" data-opt="${o.id}">${inner}</button>`;
    }).join("")}</div>`;
  } else if (it.type === "build") {
    const placed = m.builds[it.id] || [];
    const line = placed.map((k) => {
      const tok = it.bag.find((t) => t.k === k);
      return `<button type="button" class="chip-word in-line" data-unplace="${k}">${esc(tok.w)}</button>`;
    }).join("");
    const bank = it.bag.map((t) =>
      `<button type="button" class="chip-word${placed.includes(t.k) ? " is-used" : ""}" data-place="${t.k}">${esc(t.w)}</button>`
    ).join("");
    body = `<div class="build-line" id="buildLine">${line}</div>
            <div class="build-bank">${bank}</div>
            <div class="build-tools"><button type="button" class="btn btn-ghost btn-sm" data-build-undo>↶ Desfazer</button>
            <button type="button" class="btn btn-ghost btn-sm" data-build-clear>Limpar</button></div>`;
  } else {
    body = `<div class="oral-stage-note">Atividade oral/escrita: observe o aluno e registre o desempenho no painel do professor.</div>`;
  }
  $("gStage").innerHTML = `${renderShow(it.show)}<p class="stage-prompt">${esc(it.prompt)}</p>${body}`;

  // ---------- painel do professor ----------
  $("gSay").innerHTML = it.say ? `<span class="tp-label">Leia em voz alta</span>${esc(it.say)}` : "";
  const criteria = it.type === "oral" && it.rubric ? `<br><em>Critério:</em> ${esc(it.rubric)}` : "";
  $("gHint").innerHTML = it.hint ? `<span class="tp-label">Dica / critério</span>${esc(it.hint)}${criteria}` : "";
  show("gOral", it.type === "oral");
  document.querySelectorAll(".oral").forEach((b) => b.classList.toggle("is-picked", m.responses[it.id] === b.dataset.oral));

  // ---------- navegação, pontos e progresso ----------
  $("gPrev").disabled = m.index === 0;
  $("gNext").textContent = m.index === n - 1 ? "Finalizar ✓" : "Próximo →";
  $("gDots").innerHTML = m.items.map((x, i) =>
    `<span class="${i === m.index ? "now" : (m.responses[x.id] != null ? "done" : "")}"></span>`).join("");
  const done = mediatedAnswered();
  $("progressFill").style.width = `${(done / n) * 100}%`;
  $("progressText").textContent = `${done}/${n} itens registrados`;
}

/** Registra a resposta de um item e redesenha. */
function setMediatedResponse(id, value) {
  state.med.responses[id] = value;
  renderGuided();
}

/** Atualiza a resposta do item “build” a partir das fichas colocadas na linha. */
function syncBuildResponse(it) {
  const placed = state.med.builds[it.id] || [];
  const words = placed.map((k) => it.bag.find((t) => t.k === k).w);
  state.med.responses[it.id] = words.length ? words : null;
  renderGuided();
}

/** Botão “Iniciar avaliação” do modo professor. */
function startMediado() {
  const required = ["studentCode", "m_ageRange", "m_education", "m_region"];
  if (required.some((id) => !$(id).value.trim())) {
    alert("Preencha o nome do aluno, a faixa etária, a escolaridade e a região antes de começar.");
    scrollToSection("comecar");
    return;
  }
  if (!$("m_consent").checked) {
    alert("É necessário declarar a autorização para registrar o desempenho do aluno.");
    scrollToSection("comecar");
    return;
  }
  prepareMediated();
  state.startTime = Date.now();
  show("result", false);
  show("quiz", false);
  show("guided", true);
  $("progressWrap").style.display = "block";
  renderGuided();
  scrollToSection("guided");
}

/** Avança para o próximo item (ou finaliza no último). */
function guidedNext() {
  const m = state.med;
  if (m.index < m.items.length - 1) {
    m.index++;
    renderGuided();
    window.scrollTo({ top: $("guided").offsetTop - 70, behavior: "smooth" });
  } else {
    finishMediado();
  }
}

function guidedPrev() {
  if (state.med.index > 0) { state.med.index--; renderGuided(); }
}

/** Finaliza e envia. Itens sem registro contam como “não aplicados” (pontuam zero). */
async function finishMediado() {
  if (state.submitting) return;
  const m = state.med;
  const missing = m.items.length - mediatedAnswered();
  if (missing > 0 && !confirm(`${missing} item(ns) sem registro. Eles contarão como não acertados (e aparecerão como “não aplicado” no relatório). Encerrar mesmo assim?`)) return;

  const payload = {
    mode: "mediado",
    consent: true,
    ageRange: $("m_ageRange").value,
    education: $("m_education").value,
    region: $("m_region").value,
    website: $("website").value,                  // honeypot
    studentCode: $("studentCode").value.trim(),
    teacherCode: $("teacherCode").value.trim(),
    notes: m.notes.trim(),
    durationSeconds: elapsedSeconds(),
    items: m.items.map((it) => ({ id: it.id, response: m.responses[it.id] ?? null }))
  };
  await submitPayload(payload);
}

/** Ouvintes do modo professor (delegação no palco, painel e barra de navegação). */
function initGuidedEvents() {
  $("startMediado").addEventListener("click", startMediado);
  $("gPrev").addEventListener("click", guidedPrev);
  $("gNext").addEventListener("click", guidedNext);
  $("gEnd").addEventListener("click", finishMediado);
  $("gNotes").addEventListener("input", (e) => { state.med.notes = e.target.value; });

  // Cliques dentro do palco: escolher alternativa / montar frase
  $("gStage").addEventListener("click", (event) => {
    const m = state.med;
    const it = m.items[m.index];
    const opt = event.target.closest("[data-opt]");
    if (opt) { setMediatedResponse(it.id, opt.dataset.opt); return; }

    const place = event.target.closest("[data-place]");
    if (place) {
      const list = m.builds[it.id] || (m.builds[it.id] = []);
      list.push(Number(place.dataset.place));
      syncBuildResponse(it);
      return;
    }
    const unplace = event.target.closest("[data-unplace]");
    if (unplace) {
      m.builds[it.id] = (m.builds[it.id] || []).filter((k) => k !== Number(unplace.dataset.unplace));
      syncBuildResponse(it);
      return;
    }
    if (event.target.closest("[data-build-undo]")) {
      (m.builds[it.id] || []).pop();
      syncBuildResponse(it);
      return;
    }
    if (event.target.closest("[data-build-clear]")) {
      m.builds[it.id] = [];
      syncBuildResponse(it);
    }
  });

  // Registro oral (painel do professor)
  $("gOral").addEventListener("click", (event) => {
    const b = event.target.closest("[data-oral]");
    if (!b) return;
    setMediatedResponse(state.med.items[state.med.index].id, b.dataset.oral);
  });
}

/* =============================================================================
   7. ENVIO AO SERVIDOR (comum aos dois modos)
   ============================================================================= */

/** Envia o payload para /api/save_result e, se der certo, mostra o resultado. */
async function submitPayload(payload) {
  state.submitting = true;
  state.lastPayload = payload;
  const buttons = [$("btnFinishQuiz"), $("gNext"), $("gEnd")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const response = await fetch(URL_SAVE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    let result;
    try { result = await response.json(); } catch (e) { result = null; }

    if (result && result.ignored) {            // honeypot disparado
      showSaveError("Não foi possível processar esta resposta.");
      return;
    }
    if (!result || !result.ok) {
      showSaveError("Não foi possível salvar/calcular: " + ((result && result.error) || `erro ${response.status}`));
      return;
    }
    displayResult(result, payload);
  } catch (e) {
    showSaveError("Não foi possível conectar ao servidor para calcular e salvar o resultado. Abra o site por um servidor com PHP e tente de novo.");
  } finally {
    state.submitting = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/** Mostra a falha de envio (o botão “tentar de novo” reenvia as mesmas respostas). */
function showSaveError(message) {
  show("result", true);
  show("quiz", false);
  show("guided", false);
  $("progressWrap").style.display = "none";
  $("scoreValue").textContent = "—";
  $("scoreRing").style.setProperty("--angle", "0deg");
  $("resultTitle").textContent = "Suas respostas ainda não foram salvas";
  $("resultDescription").textContent = "Nada foi perdido: as respostas continuam na tela e podem ser reenviadas.";
  const status = $("saveStatus");
  status.textContent = message;
  status.classList.add("is-error");
  show("btnRetrySave", true);
  ["resultKpis", "breakdown"].forEach((id) => { $(id).innerHTML = ""; });
  show("notesCard", false); show("nextCard", false); show("inafCard", false); show("shareCard", false);
  scrollToSection("result");
}

/* =============================================================================
   8. RESULTADO
   ============================================================================= */

/** Texto de “ponto forte / ponto de atenção” a partir do desempenho por competência. */
function buildNextSteps(breakdown, mode) {
  const rows = Object.entries(breakdown || {}).map(([name, b]) => ({ name, pct: b.total ? (b.correct / b.total) * 100 : 0, w: b.weight }));
  if (!rows.length) return "";
  const byPct = [...rows].sort((a, b) => a.pct - b.pct || b.w - a.w);
  const weak = byPct[0], strong = byPct[byPct.length - 1];
  const tip = mode === "mediado"
    ? "Use este ponto para planejar a próxima atividade de apoio."
    : "Vale revisar esse tipo de tarefa com exemplos do dia a dia.";
  return `<h3>Pontos de atenção</h3>
    <p><strong>Maior dificuldade:</strong> ${esc(weak.name)} (${Math.round(weak.pct)}% de acerto). ${tip}</p>
    <p><strong>Maior facilidade:</strong> ${esc(strong.name)} (${Math.round(strong.pct)}% de acerto).</p>`;
}

/** Desenha todo o resultado a partir da resposta do servidor. */
function displayResult(result, payload) {
  const mode = result.mode;
  const score = result.score;
  const isTeacher = mode === "mediado";

  // Troca de telas: some o teste, aparece o resultado
  show("quiz", false); show("guided", false); show("result", true);
  $("progressWrap").style.display = "none";
  $("saveStatus").classList.remove("is-error");
  show("btnRetrySave", false);

  // Anel de pontuação (proporcional ao score ponderado)
  $("scoreRing").style.setProperty("--angle", `${Math.round((score / 100) * 360)}deg`);
  $("scoreValue").textContent = score;

  // Título e descrição
  if (isTeacher) {
    $("resultTitle").textContent = `Teste Fundamental (N0) — ${payload.studentCode}: ${fmt(result.correct)} de ${result.total} pontos. Score ponderado: ${score}/100.`;
  } else {
    $("resultTitle").textContent = `Você acertou ${fmt(result.correct)} de ${result.total} questões. Seu score ponderado foi ${score}/100.`;
  }
  $("resultDescription").textContent = isTeacher
    ? `No Teste Fundamental todas as competências N0 têm o mesmo peso (1), então o score ponderado coincide com o bruto (${result.scoreRaw}/100). Os pesos podem ser ajustados em lib/config.js.`
    : `O score ponderado dá mais valor às competências de maior peso. Score bruto (só contagem de acertos, sem pesos): ${result.scoreRaw}/100.`;
  $("saveStatus").textContent = isTeacher ? "Resultado salvo com sucesso." : "Resultado anônimo salvo com sucesso.";
  updateResponseCountDisplays(result.responseCount);

  // Indicadores
  $("resultKpis").innerHTML = `
    <div class="kpi"><strong>${score}</strong><span>score ponderado</span></div>
    <div class="kpi"><strong>${result.scoreRaw}</strong><span>score bruto (acertos)</span></div>
    <div class="kpi"><strong>${fmt(result.correct)}/${result.total}</strong><span>${isTeacher ? "pontos (parcial = 0,5)" : "questões certas"}</span></div>
    <div class="kpi"><strong>${fmtDuration(payload.durationSeconds)}</strong><span>tempo total</span></div>`;

  // Observações do professor e pontos de atenção
  const notes = (payload.notes || "").trim();
  show("notesCard", isTeacher && !!notes);
  $("resultNotes").textContent = notes;
  const steps = buildNextSteps(result.breakdown, mode);
  $("nextCard").innerHTML = steps;
  show("nextCard", !!steps);

  // Desempenho por competência: ordenado do menor para o maior acerto
  const rows = Object.entries(result.breakdown || {})
    .map(([name, b]) => ({ name, pct: b.total ? (b.correct / b.total) * 100 : 0, c: b.correct, t: b.total, w: b.weight }))
    .sort((a, b) => a.pct - b.pct || b.w - a.w);
  $("breakdown").innerHTML = rows.map((r) => {
    const cls = r.pct >= 70 ? "" : (r.pct >= 40 ? " mid" : " low");
    return `<div class="cb">
      <div class="cb-name">${esc(r.name)} <span class="weight">peso ${fmt(r.w)}</span></div>
      <div class="cb-track"><div class="cb-fill${cls}" style="width:${Math.round(r.pct)}%"></div></div>
      <div class="cb-val">${Math.round(r.pct)}%</div>
    </div>`;
  }).join("");

  // Referência nacional INAF (somente Teste de Interpretação)
  show("inafCard", !isTeacher);
  if (!isTeacher) {
    const functional = INAF_2024[0].pct + INAF_2024[1].pct;
    const below = functional + INAF_2024[2].pct;
    $("inafCard").innerHTML = `
      <h3>Referência nacional — INAF 2024</h3>
      <p class="muted small">Percentual da população brasileira de 15 a 64 anos em cada nível. Analfabetismo funcional = Analfabeto + Rudimentar.</p>
      <div class="inaf-stack">${INAF_2024.map((n) => `<div class="inaf-seg" style="width:${n.pct}%;background:${n.color}"><span>${n.pct}%<br>${n.name}</span></div>`).join("")}</div>
      <p>Nos dados oficiais, ${functional}% da população está em analfabetismo funcional e ${below}% não alcança os níveis Intermediário ou Proficiente.</p>
      <p class="muted small">Referência para contexto — este teste não classifica a pessoa em um nível do INAF. O score é ponderado por competência; o número bruto de acertos aparece para transparência.</p>`;
  }

  // Texto de compartilhamento (não oferecido no teste fundamental, por privacidade)
  show("shareCard", !isTeacher);
  $("btnCopy").classList.toggle("hidden", isTeacher);
  if (!isTeacher) {
    $("shareText").value = `Fiz o teste de interpretação do Arvorecer e meu score ponderado foi ${score}/100. Acertei ${fmt(result.correct)} de ${result.total} questões. Teste educativo inspirado em habilidades de alfabetismo funcional.`;
  }

  scrollToSection("result");
}

/** Copia o texto de compartilhamento. */
async function copyShareText() {
  const area = $("shareText");
  try {
    await navigator.clipboard.writeText(area.value);
    alert("Texto copiado!");
  } catch (e) {
    area.focus(); area.select();
    alert("Selecione e copie o texto manualmente.");
  }
}

/** Volta para a preparação para uma nova avaliação. */
function newTest() {
  show("result", false); show("quiz", false); show("guided", false);
  $("progressWrap").style.display = "none";
  state.lastPayload = null;
  scrollToSection("comecar");
}

/* =============================================================================
   9. INICIALIZAÇÃO
   ============================================================================= */

function init() {
  // Os formulários são tratados por JS (botões); impede o envio padrão do navegador ao apertar Enter.
  // (Antes isto era onsubmit="return false" no HTML, que a política de segurança da Vercel bloqueia.)
  ["formAutonomo", "formMediado", "quizForm"].forEach((id) => {
    const f = $(id);
    if (f) f.addEventListener("submit", (e) => e.preventDefault());
  });

  initThemeToggle();
  initNavigation();
  initQuizEvents();
  initGuidedEvents();

  $("btnPrint").addEventListener("click", () => window.print());
  $("btnCopy").addEventListener("click", copyShareText);
  $("btnNewTest").addEventListener("click", newTest);
  $("btnToggleComp").addEventListener("click", toggleCompetencies);
  $("btnRetrySave").addEventListener("click", () => { if (state.lastPayload) submitPayload(state.lastPayload); });

  setMode("autonomo");
  loadWeights();
  loadPublicResponseCount();
  $("progressText").textContent = `0/${getSelectedTotal()} respondidas`;
}

init();
