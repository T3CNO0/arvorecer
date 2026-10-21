/* =============================================================================
   ARVORECER — /api/save_result
   -----------------------------------------------------------------------------
   Recebe as respostas do navegador (JSON via POST), CALCULA a nota no servidor
   (com pesos por competência), SALVA tudo no banco e devolve o resultado.

   Por que calcular aqui e não no navegador?
     - o gabarito fica escondido (ninguém consegue "olhar a resposta");
     - o resultado salvo é o mesmo que a pessoa vê, sem possibilidade de adulteração.

   Dois modos (campo "mode"):
     "autonomo" -> Teste de Interpretação (N1–N4): { mode, consent, ageRange, education,
                   region, arrivalSource, website(honeypot), total(30|50),
                   durationSeconds, questionIds[], answers[] }
     "mediado"  -> Teste Fundamental (N0): { mode, consent, ageRange, education, region,
                   studentCode, teacherCode, notes, durationSeconds, items:[{id,response}] }
   ============================================================================= */
'use strict';
const cfg = require('../lib/config');
const db = require('../lib/db');
const { json, readJson, HttpError } = require('../lib/http');
const { ipHash } = require('../lib/security');
const users = require('../lib/users');
const { scoreAutonomo, scoreMediado, summarize, cleanText } = require('../lib/scoring');

/** Equivalente ao empty() do PHP (o honeypot trata "0", 0, [] e "" como vazio). */
function phpEmpty(v) {
  return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0'
    || (Array.isArray(v) && v.length === 0);
}
/** (int) do PHP, para números e textos numéricos. */
function toInt(v) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; }

module.exports = async (req, res) => {
  // 1) Só aceitamos POST
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Método não permitido.' });

  try {
    // 2) Corpo JSON (limite de 200 KB)
    let input;
    try { input = await readJson(req); }
    catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { ok: false, error: e.message });
      throw e;
    }

    // 3) Honeypot: campo invisível que só robôs preenchem
    if (!phpEmpty(input.website)) return json(res, 200, { ok: true, ignored: true });

    const mode = input.mode === 'mediado' ? 'mediado' : 'autonomo';

    // 4) Consentimento e dados demográficos (validados contra listas fixas)
    if (input.consent !== true) {
      return json(res, 400, { ok: false, error: 'É necessário aceitar o armazenamento anônimo dos dados.' });
    }
    const age = input.ageRange === undefined ? '' : input.ageRange;
    const edu = input.education === undefined ? '' : input.education;
    const reg = input.region === undefined ? '' : input.region;
    if (!cfg.ALLOWED_AGE.includes(age) || !cfg.ALLOWED_EDUCATION.includes(edu) || !cfg.ALLOWED_REGION.includes(reg)) {
      return json(res, 400, { ok: false, error: 'Dados do formulário inválidos.' });
    }
    let src;
    if (mode === 'autonomo') {
      src = input.arrivalSource === undefined ? '' : input.arrivalSource;
      if (!cfg.ALLOWED_SOURCE.includes(src)) {
        return json(res, 400, { ok: false, error: 'Dados do formulário inválidos.' });
      }
    } else {
      src = 'professor';
    }

    // 5) Limite de envios por visitante por hora
    const hash = ipHash(req);
    const rl = await db.query(
      `SELECT COUNT(*)::int AS n FROM submissions WHERE ip_hash = $1 AND created_at >= now() - interval '1 hour'`,
      [hash]
    );
    if (rl.rows[0].n >= cfg.RATE_LIMIT_PER_HOUR) {
      return json(res, 429, { ok: false, error: 'Muitos envios deste dispositivo. Tente novamente mais tarde.' });
    }

    // 6) Pontuação conforme o modo
    let scored, total;
    if (mode === 'autonomo') {
      total = toInt(input.total);
      if (total !== 30 && total !== 50) return json(res, 400, { ok: false, error: 'Tamanho de teste inválido.' });
      const ids = Array.isArray(input.questionIds) ? input.questionIds : [];
      const ans = Array.isArray(input.answers) ? input.answers : [];
      scored = scoreAutonomo(ids, ans, total);
    } else {
      const items = Array.isArray(input.items) ? input.items : [];
      scored = scoreMediado(items);
      total = scored.rows.length;
    }
    if (scored.error !== null) return json(res, 400, { ok: false, error: scored.error });
    const rows = scored.rows;

    const { breakdown, points, weighted, raw } = summarize(rows);

    // 7) Campos extras (teste fundamental) e duração
    const duration = Math.max(0, Math.min(86400, toInt(input.durationSeconds)));
    const student = mode === 'mediado' ? cleanText(input.studentCode, 60) : '';
    const teacher = mode === 'mediado' ? cleanText(input.teacherCode, 60) : '';
    const notes = mode === 'mediado' ? cleanText(input.notes, 1500) : '';

    // Liga o teste à conta do professor, se o código digitado for de um professor ativo
    let teacherId = null;
    if (mode === 'mediado' && teacher) {
      const t = await users.byCode(teacher);
      if (t) teacherId = t.id;
    }

    // 8) Grava tudo numa transação (tudo-ou-nada)
    const count = await db.transaction(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO submissions
           (mode, age_range, education, region, arrival_source, total, correct,
            score_weighted, score_raw, duration_seconds, student_code, teacher_code,
            notes, ip_hash, breakdown_json, teacher_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [mode, age, edu, reg, src, total, points, weighted, raw, duration, student, teacher, notes, hash,
         JSON.stringify(breakdown), teacherId]
      );
      const subId = ins.rows[0].id;
      // uma única inserção em lote (≤ 50 linhas)
      const vals = [];
      const params = [];
      rows.forEach((r, i) => {
        const o = i * 7;
        vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
        params.push(subId, r.question_id, r.competency, r.group_idx, r.answer, r.points, r.weight);
      });
      await tx.query(
        `INSERT INTO answers (submission_id, question_id, competency, group_idx, answer, points, weight)
         VALUES ${vals.join(',')}`,
        params
      );
      const c = await tx.query('SELECT COUNT(*)::int AS n FROM submissions');
      return c.rows[0].n;
    });

    // 9) Devolve o resultado ao navegador (sem o gabarito!)
    json(res, 200, {
      ok: true,
      mode,
      score: weighted,       // score ponderado 0-100
      scoreRaw: raw,         // score bruto 0-100
      correct: points,
      total,
      breakdown,             // por competência: correct, total, weight
      responseCount: count,
    });
  } catch (e) {
    // Não vazamos detalhes ao visitante; o erro vai para o log da Vercel.
    console.error('[arvorecer]', e && e.message);
    json(res, 500, { ok: false, error: 'Erro interno ao salvar. Avise o responsável pelo teste.' });
  }
};
