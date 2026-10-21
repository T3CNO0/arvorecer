/* =============================================================================
   ARVORECER — PESOS E PONTUAÇÃO  (lib/scoring.js)
   -----------------------------------------------------------------------------
   Porte fiel de lib.php: mesmos pesos, mesmas validações de integridade, mesmo
   arredondamento. O gabarito vem de lib/answer_key.js (nunca vai para o navegador).
   ============================================================================= */
'use strict';

const cfg = require('./config');

let _key = null;
/** Gabarito (carregado uma única vez, só no servidor). */
function answerKey() {
  if (!_key) _key = require('./answer_key');
  return _key;
}

/* ------------------------------ PESOS ------------------------------------ */

/** Peso de UMA competência (ex.: 'N2C6'): o próprio 'weight', senão o peso-base do nível. */
function competencyWeight(code) {
  const c = cfg.COMPETENCIES[code];
  if (!c) return Number(cfg.DEFAULT_WEIGHT);
  if (c.weight !== undefined && c.weight !== null) return Number(c.weight);
  const lv = cfg.LEVELS[c.level];
  return Number(lv && lv.weight !== undefined ? lv.weight : cfg.DEFAULT_WEIGHT);
}

const _qwCache = new Map();
/** Arredonda como o PHP round(): metade para longe do zero, 4 casas. */
function round4(x) { return Math.round((x + Number.EPSILON) * 10000) / 10000; }

/**
 * Peso de uma questão do Teste de Interpretação: média do peso dos níveis em que o tipo
 * aparece na matriz, ponderada pela cobertura (● = 1, ○ = 0,5). Fora da matriz → alias → padrão.
 */
function questionWeight(domain) {
  if (_qwCache.has(domain)) return _qwCache.get(domain);
  const name = cfg.DOMAIN_ALIASES[domain] || domain;
  const cells = cfg.TEST_MATRIX[name];
  let result;
  if (!cells || !cells.length) {
    result = Number(cfg.DEFAULT_WEIGHT);
  } else {
    let num = 0, den = 0;
    for (const [codes, cov] of cells) {
      // uma célula = um nível; vários códigos na mesma célula → média dos pesos deles
      const w = codes.reduce((s, c) => s + competencyWeight(c), 0) / codes.length;
      num += cov * w;
      den += cov;
    }
    result = round4(num / den);
  }
  _qwCache.set(domain, result);
  return result;
}

/** Texto "N0C1 – Reconhecer letras…" usado no relatório do teste fundamental. */
function competencyLabel(code) {
  const c = cfg.COMPETENCIES[code];
  return c ? `${code} – ${c.title}` : code;
}

/* ------------------------------ TEXTO ------------------------------------ */

/** Remove caracteres de controle, apara e corta no máximo (em caracteres Unicode). */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  let v = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return Array.from(v).slice(0, max).join('');
}

/* ------------------------------ RESUMO ----------------------------------- */

/** Resumo por competência. Retorna { breakdown, points, weighted, raw }. */
function summarize(rows) {
  const breakdown = {};
  let sumW = 0, sumWC = 0, points = 0;
  for (const r of rows) {
    const c = r.label || r.competency;
    if (!Object.prototype.hasOwnProperty.call(breakdown, c)) {
      breakdown[c] = { correct: 0, total: 0, weight: r.weight };
    }
    breakdown[c].total++;
    breakdown[c].correct += r.points;
    sumW += r.weight;
    sumWC += r.weight * r.points;
    points += r.points;
  }
  const n = rows.length;
  const weighted = sumW > 0 ? Math.round(sumWC / sumW * 100) : 0;
  const raw = n > 0 ? Math.round(points / n * 100) : 0;
  return { breakdown, points, weighted, raw };
}

/* ------------------- TESTE DE INTERPRETAÇÃO (N1–N4) ---------------------- */

/** Retorna { rows, error }. Exige um item de cada grupo esperado (impede montar teste só fácil). */
function scoreAutonomo(ids, answers, total) {
  const key = answerKey().autonomo;
  const expected = total === 50
    ? Array.from({ length: key.groups }, (_, i) => i)
    : key.short.slice();

  if (ids.length !== total || answers.length !== total) {
    return { rows: [], error: 'Quantidade de respostas diferente do tamanho do teste.' };
  }

  const seen = new Set();
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const qid = ids[i];
    if (typeof qid !== 'string' || !Object.prototype.hasOwnProperty.call(key.items, qid)) {
      return { rows: [], error: 'Questão desconhecida.' };
    }
    const info = key.items[qid];
    if (seen.has(info.g)) return { rows: [], error: 'Há duas questões do mesmo grupo.' };
    seen.add(info.g);

    const ans = answers[i];
    if (typeof ans !== 'string' || !/^[a-d]$/.test(ans)) {
      return { rows: [], error: 'Resposta inválida.' };
    }
    rows.push({
      question_id: qid,
      competency: info.d,
      group_idx: info.g,
      answer: ans,
      points: ans === info.a ? 1 : 0,
      weight: questionWeight(info.d),
    });
  }
  const got = Array.from(seen).sort((a, b) => a - b);
  const exp = expected.sort((a, b) => a - b);
  if (got.length !== exp.length || got.some((g, i) => g !== exp[i])) {
    return { rows: [], error: 'Conjunto de questões inválido para este tamanho de teste.' };
  }
  return { rows, error: null };
}

/* --------------------- TESTE FUNDAMENTAL (N0, professor) ----------------- */

/** choice → id da alternativa; build → lista de palavras; oral → 'ok'|'parcial'|'nao'. */
function scoreMediado(items) {
  const key = answerKey().mediado.items;
  if (items.length !== Object.keys(key).length) {
    return { rows: [], error: 'Quantidade de itens diferente do esperado.' };
  }

  const seen = new Set();
  const rows = [];
  for (const it of items) {
    const id = it && typeof it === 'object' && typeof it.id === 'string' ? it.id : '';
    if (id === '' || !Object.prototype.hasOwnProperty.call(key, id) || seen.has(id)) {
      return { rows: [], error: 'Item inválido ou repetido.' };
    }
    seen.add(id);
    const info = key[id];
    const resp = it.response === undefined ? null : it.response;

    let points = 0;
    let stored = '';
    if (info.t === 'choice') {
      if (typeof resp === 'string' && /^[a-d]$/.test(resp)) {
        stored = resp;
        points = resp === info.a ? 1 : 0;
      }
    } else if (info.t === 'build') {
      if (Array.isArray(resp)) {
        const words = resp.map((w) => (typeof w === 'string' ? Array.from(w.trim()).slice(0, 40).join('') : ''));
        stored = words.join(' ');
        points = words.length === info.a.length && words.every((w, i) => w === info.a[i]) ? 1 : 0;
      }
    } else { // oral
      if (typeof resp === 'string' && Object.prototype.hasOwnProperty.call(cfg.ORAL_POINTS, resp)) {
        stored = resp;
        points = Number(cfg.ORAL_POINTS[resp]);
      }
    }
    rows.push({
      question_id: id,
      competency: info.d,
      group_idx: null,
      answer: stored,
      points,
      weight: competencyWeight(info.d),
      label: competencyLabel(info.d),
    });
  }
  return { rows, error: null };
}

module.exports = { competencyWeight, questionWeight, competencyLabel, cleanText, summarize, scoreAutonomo, scoreMediado };
