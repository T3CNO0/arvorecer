/* =============================================================================
   ARVORECER — /admin  (PAINEL DE RESULTADOS)  → api/admin.js
   -----------------------------------------------------------------------------
   Aqui você vê e baixa tudo o que foi respondido:
     • resumo geral e por teste (Interpretação N1–N4 / Fundamental N0);
     • lista dos testes mais recentes (filtro por modo);
     • detalhe de cada teste, item a item, com a competência e o peso;
     • exportação em CSV (testes e respostas) — abre direto no Excel.

   CONTAS: administrador principal (vê tudo e gerencia a equipe) e professores (veem só
   os testes Fundamentais cujo "código do professor" é o da conta deles).
   Convite e recuperação de senha SEM e-mail: o administrador principal gera um link de
   uso único e o entrega à pessoa.

   Para ativar: defina SESSION_SECRET, ADMIN_EMAIL e ADMIN_PASSWORD (a 1ª conta é criada
   a partir deles quando ainda não existe nenhuma). Acesse /admin.

   Segurança: senhas com scrypt, e-mail desconhecido leva o mesmo tempo e a mesma mensagem
   que senha errada, atraso de 1 s e bloqueio após 10 erros (por visitante e por conta),
   cookie assinado HttpOnly + SameSite=Strict (+Secure em HTTPS) que cai se a conta for
   desativada ou trocar a senha, verificação de Origin nos formulários, links de uso
   único guardados só como hash, CSV protegido contra injeção de fórmula, HTML escapado.
   ============================================================================= */
'use strict';
const cfg = require('../lib/config');
const db = require('../lib/db');
const sec = require('../lib/security');
const users = require('../lib/users');
const { html, readForm, queryOf, HttpError } = require('../lib/http');

/** Escapa texto para HTML (evita XSS com dados vindos dos respondentes). */
function h(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
/** Nome exibido do teste: autonomo = Interpretação (N1–N4); mediado = Fundamental (N0). */
function modeLabel(m) { return m === 'mediado' ? 'Fundamental (N0)' : 'Interpretação (N1–N4)'; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Número como o PHP imprime (0.5, 3, 12.5). */
function num(v) { return v === null || v === undefined ? '' : String(Number(v)); }

/** Data/hora UTC como texto fixo, para listas e CSV. */
const TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

const CSS = `<style>
:root{color-scheme:light dark;--bg:#f6f3ea;--sf:#fffdf8;--tx:#1d2a22;--mu:#66736b;--ln:#e3dccb;--pr:#1f7a4d}
@media(prefers-color-scheme:dark){:root{--bg:#0e1612;--sf:#14201a;--tx:#eef3ee;--mu:#9db0a4;--ln:#25362c;--pr:#58c08a}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--tx)}
.w{max-width:1200px;margin:0 auto;padding:24px 16px 60px}h1{margin:0 0 4px}a{color:var(--pr)}
.card{background:var(--sf);border:1px solid var(--ln);border-radius:14px;padding:16px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi b{display:block;font-size:1.8rem;color:var(--pr)}.kpi span{color:var(--mu);font-size:.85rem}
table{width:100%;border-collapse:collapse;font-size:.88rem}th,td{padding:8px 6px;border-bottom:1px solid var(--ln);text-align:left;vertical-align:top}
th{color:var(--mu);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
.btn{display:inline-block;padding:8px 14px;border-radius:10px;background:var(--pr);color:#fff;text-decoration:none;border:0;font:inherit;cursor:pointer}
.btn.g{background:transparent;color:var(--pr);border:1px solid var(--ln)}input[type=password],input[type=email],input[type=text]{padding:10px;border:1px solid var(--ln);border-radius:10px;font:inherit;background:var(--bg);color:var(--tx)}
.inl{display:inline-block;margin:0 4px 4px 0}.mu{color:var(--mu)}.tag{padding:2px 8px;border-radius:99px;border:1px solid var(--ln);font-size:.75rem}
.pw{width:100%;margin:6px 0 12px}.err{color:#c2410c}.narrow{max-width:420px}.scroll{overflow-x:auto}
</style>`;
const HEAD = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arvorecer · Painel</title>' + CSS;

/* ---------- páginas de acesso (sem login) ---------- */
function authPage(title, inner) {
  return HEAD + `<div class="w narrow"><h1>🌱 Arvorecer</h1><p class="mu">${h(title)}</p>${inner}</div>`;
}
function loginPage(error, notice) {
  return authPage('Painel de resultados', '<form method="post" action="/admin" class="card"><input type="hidden" name="action" value="login">'
    + '<label>E-mail<br><input type="email" name="email" class="pw" autofocus required autocomplete="username"></label>'
    + '<label>Senha<br><input type="password" name="password" class="pw" required autocomplete="current-password"></label>'
    + (error ? '<p class="err">' + h(error) + '</p>' : '') + (notice ? '<p class="mu">' + h(notice) + '</p>' : '')
    + '<button class="btn">Entrar</button></form>'
    + '<p class="mu">Esqueceu a senha? Peça ao administrador principal um novo link de acesso.</p>');
}
function setupPage(user, token, error) {
  return authPage('Definir senha', `<form method="post" action="/admin" class="card"><input type="hidden" name="action" value="setup"><input type="hidden" name="token" value="${h(token)}">`
    + `<p>Conta: <b>${h(user.email)}</b></p>`
    + `<label>Nova senha (mín. ${users.MIN_PASSWORD} caracteres)<br><input type="password" name="password" class="pw" required minlength="${users.MIN_PASSWORD}" autocomplete="new-password"></label>`
    + '<label>Repita a senha<br><input type="password" name="password2" class="pw" required autocomplete="new-password"></label>'
    + (error ? '<p class="err">' + h(error) + '</p>' : '') + '<button class="btn">Salvar senha</button></form>');
}

/* ---------- escopo: professor só enxerga os testes dele ---------- */
/** Devolve { where, params } para submissions (alias s). p0 = índice do 1º parâmetro livre. */
function scope(user, alias, startIdx) {
  if (user.role === 'owner') return { where: '', params: [] };
  return { where: `${alias}.teacher_id = $${startIdx}`, params: [user.id] };
}
const and = (cond) => (cond ? ' AND ' + cond : '');

/** Uma linha CSV no formato do fputcsv do PHP (separador ;), com a guarda contra fórmulas. */
function csvLine(cells) {
  return cells.map((cell) => {
    let s = cell === null || cell === undefined ? '' : String(cell);
    if (typeof cell === 'string' && s !== '' && '=+-@'.includes(s[0])) s = "'" + s;   // anti-injeção de fórmula
    return /[;"\n\r\t ]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';') + '\n';
}

async function exportCsv(res, user, type) {
  let header, r;
  if (type === 'answers') {
    const sc = scope(user, 's', 1);
    header = ['teste_id', 'data_utc', 'modo', 'questao', 'competencia', 'peso', 'resposta', 'pontos'];
    r = await db.query(
      `SELECT s.id, to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ts, s.mode,
              a.question_id, a.competency, a.weight, a.answer, a.points
         FROM answers a JOIN submissions s ON s.id = a.submission_id ${sc.where ? 'WHERE ' + sc.where : ''} ORDER BY s.id, a.id`, sc.params);
  } else {
    type = 'submissions';
    const sc = scope(user, 's', 1);
    header = ['id', 'data_utc', 'modo', 'faixa_etaria', 'escolaridade', 'regiao', 'origem', 'itens',
              'acertos', 'score_ponderado', 'score_bruto', 'duracao_s', 'nome_aluno', 'nome_professor', 'observacoes'];
    r = await db.query(
      `SELECT s.id, to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ts, s.mode, s.age_range, s.education, s.region, s.arrival_source, s.total, s.correct,
              s.score_weighted, s.score_raw, s.duration_seconds, s.student_code, s.teacher_code, s.notes
         FROM submissions s ${sc.where ? 'WHERE ' + sc.where : ''} ORDER BY s.id`, sc.params);
  }
  let out = '﻿' + csvLine(header);   // BOM: o Excel reconhece os acentos
  for (const row of r.rows) out += csvLine(Object.values(row));
  const d = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="arvorecer_${type}_${d}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(out);
}

function menu(user) {
  return '<h1>🌱 Arvorecer · Resultados</h1><p class="mu">' + h(user.name) + ' (' + (user.role === 'owner' ? 'administrador principal' : 'professor') + ') · '
    + '<a href="/admin">Visão geral</a> · <a href="/admin?export=submissions">Baixar testes (CSV)</a> · <a href="/admin?export=answers">Baixar respostas (CSV)</a>'
    + (user.role === 'owner' ? ' · <a href="/admin?team=1">Equipe</a>' : '') + ' · <a href="/admin?account=1">Minha conta</a> · <a href="/admin?logout=1">Sair</a></p>'
    + (user.role === 'teacher' ? `<p class="mu">Seu código de professor: <b>${h(user.code)}</b> — digite-o no campo “Nome do Professor” do Teste Fundamental para que o teste apareça aqui.</p>` : '');
}

async function detailPage(res, user, id) {
  const sc = scope(user, 's', 2);
  const sr = await db.query(`SELECT s.*, to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ts FROM submissions s WHERE s.id = $1${and(sc.where)}`, [id, ...sc.params]);
  const s = sr.rows[0];
  if (!s) return html(res, 404, HEAD + '<div class="w"><p>Teste não encontrado.</p><p><a href="/admin">Voltar</a></p></div>');
  let o = menu(user);
  o += `<div class="card"><h2>Teste #${h(s.id)} <span class="tag">${h(modeLabel(s.mode))}</span></h2>`;
  o += `<p>${h(s.ts)} UTC · ${h(s.age_range)} · ${h(s.education)} · ${h(s.region)}</p>`;
  o += `<p><b>Score ponderado: ${h(s.score_weighted)}/100</b> · bruto ${h(s.score_raw)}/100 · ${h(num(s.correct))} de ${h(s.total)} · ${h(s.duration_seconds)} s</p>`;
  if (s.mode === 'mediado') {
    o += `<p>Aluno: <b>${h(s.student_code || '—')}</b> · Professor: <b>${h(s.teacher_code || '—')}</b></p>`;
    if (s.notes) o += `<p><b>Observações:</b><br>${h(s.notes).replace(/\n/g, '<br>')}</p>`;
  }
  o += '</div>';

  let bd = s.breakdown_json;
  if (typeof bd === 'string') { try { bd = JSON.parse(bd); } catch (_) { bd = {}; } }
  bd = bd || {};
  o += '<div class="card"><h3>Por competência</h3><table><tr><th>Competência</th><th>Peso</th><th>Acertos</th><th>%</th></tr>';
  for (const [name, b] of Object.entries(bd)) {
    const pct = b.total ? Math.round(b.correct / b.total * 100) : 0;
    o += `<tr><td>${h(name)}</td><td>${h(num(b.weight))}</td><td>${h(num(b.correct))}/${h(b.total)}</td><td>${pct}%</td></tr>`;
  }
  o += '</table></div>';

  const ar = await db.query('SELECT * FROM answers WHERE submission_id = $1 ORDER BY id', [s.id]);
  o += '<div class="card"><h3>Respostas</h3><table><tr><th>Questão</th><th>Competência</th><th>Resposta</th><th>Pontos</th></tr>';
  for (const a of ar.rows) {
    o += `<tr><td>${h(a.question_id)}</td><td>${h(a.competency)}</td><td>${h(a.answer === '' ? '(não aplicado)' : a.answer)}</td><td>${h(num(a.points))}</td></tr>`;
  }
  o += '</table></div></div>';
  html(res, 200, HEAD + '<div class="w">' + o);
}

async function overviewPage(res, user, filter) {
  const sc1 = scope(user, 's', 1);
  const W = sc1.where ? 'WHERE ' + sc1.where : '';
  const tot = (await db.query(`SELECT COUNT(*)::int AS n FROM submissions s ${W}`, sc1.params)).rows[0].n;
  const byMode = (await db.query(
    `SELECT s.mode, COUNT(*)::int AS c, ROUND(AVG(s.score_weighted)::numeric, 1) AS m FROM submissions s ${W} GROUP BY s.mode ORDER BY s.mode`, sc1.params)).rows;
  let o = menu(user);
  o += `<div class="grid"><div class="card kpi"><b>${tot}</b><span>testes registrados</span></div>`;
  for (const m of byMode) o += `<div class="card kpi"><b>${h(m.c)}</b><span>${h(modeLabel(m.mode))} · média ponderada ${h(num(m.m))}</span></div>`;
  o += '</div>';

  const dist = (await db.query(
    `SELECT s.mode, LEAST(s.score_weighted / 10, 9) AS b, COUNT(*)::int AS c FROM submissions s ${W} GROUP BY s.mode, b ORDER BY s.mode, b`, sc1.params)).rows;
  o += '<div class="card"><h3>Distribuição do score ponderado</h3><table><tr><th>Teste</th><th>Faixa de pontos</th><th>Testes</th></tr>';
  for (const l of dist) {
    const lo = Number(l.b) * 10, hi = lo === 90 ? 100 : lo + 9;
    o += `<tr><td>${h(modeLabel(l.mode))}</td><td>${lo} a ${hi}</td><td>${h(l.c)}</td></tr>`;
  }
  o += '</table></div>';

  const valid = ['autonomo', 'mediado'].includes(filter);
  const conds = [], params = [...sc1.params];
  if (sc1.where) conds.push(sc1.where);
  if (valid) { params.push(filter); conds.push(`s.mode = $${params.length}`); }
  const list = (await db.query(
    `SELECT s.id, to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ts, s.mode, s.age_range, s.education, s.region, s.total, s.correct, s.score_weighted, s.score_raw, s.student_code
       FROM submissions s ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 200`, params)).rows;
  o += '<div class="card"><h3>Últimos 200 testes</h3><p class="mu">Filtro: <a href="/admin">todos</a> · <a href="/admin?mode=autonomo">interpretação</a> · <a href="/admin?mode=mediado">fundamental</a></p>';
  o += '<div class="scroll"><table><tr><th>#</th><th>Data (UTC)</th><th>Modo</th><th>Idade</th><th>Escolaridade</th><th>Região</th><th>Acertos</th><th>Ponderado</th><th>Bruto</th><th>Aluno</th></tr>';
  for (const r of list) {
    o += `<tr><td><a href="/admin?id=${h(r.id)}">${h(r.id)}</a></td><td>${h(r.ts)}</td><td>${h(modeLabel(r.mode))}</td><td>${h(r.age_range)}</td><td>${h(r.education)}</td><td>${h(r.region)}</td><td>${h(num(r.correct))}/${h(r.total)}</td><td><b>${h(r.score_weighted)}</b></td><td>${h(r.score_raw)}</td><td>${h(r.student_code)}</td></tr>`;
  }
  o += '</table></div></div></div>';
  html(res, 200, HEAD + '<div class="w">' + o);
}

/* ---------- equipe (só administrador principal) ---------- */
async function teamPage(res, user, message, link) {
  const all = await users.listAll();
  let o = menu(user) + '<div class="card"><h3>Equipe</h3>';
  if (message) o += `<p class="err">${h(message)}</p>`;
  if (link) o += `<div class="card"><p><b>Link de acesso (aparece só agora — copie e entregue à pessoa):</b></p><p><code>${h(link.url)}</code></p><p class="mu">Conta: ${h(link.email)} · uso único · vale por ${link.hours} horas.</p></div>`;
  o += '<div class="scroll"><table><tr><th>Nome</th><th>E-mail</th><th>Código</th><th>Perfil</th><th>Situação</th><th>Ações</th></tr>';
  for (const u of all) {
    const status = !u.active ? 'desativada' : (u.password_hash ? 'ativa' : 'aguardando 1º acesso');
    const self = u.id === user.id;
    const act = (name, label, extra) => `<form method="post" action="/admin" class="inl"><input type="hidden" name="action" value="${name}"><input type="hidden" name="uid" value="${u.id}">${extra || ''}<button class="btn g">${label}</button></form>`;
    o += `<tr><td>${h(u.name)}</td><td>${h(u.email)}</td><td>${h(u.code)}</td><td>${u.role === 'owner' ? 'principal' : 'professor'}</td><td>${status}</td><td>`
      + (u.active ? act('reset', u.password_hash ? 'Gerar link de nova senha' : 'Gerar novo convite') : '')
      + (!self && u.role !== 'owner' ? act('toggle', u.active ? 'Desativar' : 'Reativar', `<input type="hidden" name="active" value="${u.active ? 0 : 1}">`) : '')
      + '</td></tr>';
  }
  o += '</table></div></div>';
  o += '<div class="card"><h3>Convidar professor</h3><form method="post" action="/admin"><input type="hidden" name="action" value="invite">'
    + '<label>Nome<br><input type="text" name="name" class="pw" required maxlength="80"></label>'
    + '<label>E-mail<br><input type="email" name="email" class="pw" required maxlength="254"></label>'
    + '<button class="btn">Criar convite</button></form><p class="mu">Será gerado um link para a pessoa definir a própria senha.</p></div></div>';
  html(res, 200, HEAD + '<div class="w">' + o);
}

function accountPage(res, user, message, ok) {
  let o = menu(user) + '<div class="card"><h3>Minha conta</h3>'
    + `<p>${h(user.name)} · ${h(user.email)} · código <b>${h(user.code)}</b></p>`
    + '<form method="post" action="/admin"><input type="hidden" name="action" value="chpw">'
    + '<label>Senha atual<br><input type="password" name="current" class="pw" required autocomplete="current-password"></label>'
    + `<label>Nova senha (mín. ${users.MIN_PASSWORD} caracteres)<br><input type="password" name="password" class="pw" required minlength="${users.MIN_PASSWORD}" autocomplete="new-password"></label>`
    + '<label>Repita a nova senha<br><input type="password" name="password2" class="pw" required autocomplete="new-password"></label>'
    + (message ? `<p class="${ok ? 'mu' : 'err'}">${h(message)}</p>` : '')
    + '<button class="btn">Trocar senha</button></form></div></div>';
  html(res, 200, HEAD + '<div class="w">' + o);
}

function redirect(res, location, extra) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
  res.end();
}
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${req.headers.host}`;
}

async function handleLogin(req, res, form) {
  const email = users.normEmail(form.email);
  if (await sec.recentFailures(req, email) >= cfg.ADMIN_MAX_FAILURES) {
    return html(res, 429, loginPage('Muitas tentativas. Aguarde alguns minutos e tente de novo.'));
  }
  const u = email ? await users.byEmail(email) : null;
  let good = false;
  if (u && u.active && u.password_hash) good = await users.verifyPassword(String(form.password || ''), u.password_hash);
  else await users.dummyVerify(String(form.password || ''));      // mesmo tempo de resposta
  if (good) return redirect(res, '/admin', { 'Set-Cookie': sec.sessionCookie(req, sec.makeSession(u), cfg.ADMIN_SESSION_HOURS * 3600) });
  await sec.recordFailure(req, email);
  await sleep(1000);                                              // atrasa tentativas de adivinhação
  return html(res, 401, loginPage('E-mail ou senha incorretos.'));
}

async function handleSetup(req, res, form) {
  const token = String(form.token || '');
  const user = await users.userForToken(token);
  if (!user) return html(res, 400, authPage('Link inválido', '<p class="err">Link inválido ou expirado. Peça um novo ao administrador principal.</p>'));
  if (form.password !== form.password2) return html(res, 400, setupPage(user, token, 'As senhas não conferem.'));
  const err = await users.setPasswordWithToken(token, String(form.password || ''));
  if (err) return html(res, 400, setupPage(user, token, err));
  return html(res, 200, loginPage('', 'Senha definida. Entre com seu e-mail e a nova senha.'));
}

module.exports = async (req, res) => {
  try {
    if (!sec.adminEnabled()) {
      return html(res, 403, 'Painel desativado: defina SESSION_SECRET, ADMIN_EMAIL e ADMIN_PASSWORD nas variáveis de ambiente.');
    }
    await users.bootstrapOwner();
    if (!(await users.hasAnyUser())) {
      return html(res, 403, 'Painel desativado: defina ADMIN_EMAIL (e-mail válido) e ADMIN_PASSWORD (mín. ' + users.MIN_PASSWORD + ' caracteres) para criar o primeiro administrador.');
    }
    const q = queryOf(req);

    // sair
    if (q.logout !== undefined) return redirect(res, '/admin', { 'Set-Cookie': sec.sessionCookie(req, '', 0) });

    // link de definição de senha (convite / redefinição)
    if (req.method !== 'POST' && q.setup !== undefined) {
      const u = await users.userForToken(String(q.setup));
      return u ? html(res, 200, setupPage(u, String(q.setup)))
               : html(res, 400, authPage('Link inválido', '<p class="err">Link inválido ou expirado. Peça um novo ao administrador principal.</p>'));
    }

    let form = {};
    if (req.method === 'POST') {
      if (!sec.sameOrigin(req)) return html(res, 403, 'Origem não permitida.');
      try { form = await readForm(req); } catch (e) { if (e instanceof HttpError) return html(res, e.status, 'Requisição inválida.'); throw e; }
      if (form.action === 'login') return await handleLogin(req, res, form);
      if (form.action === 'setup') return await handleSetup(req, res, form);
    }

    // a partir daqui é preciso estar logado
    const user = await sec.currentUser(req);
    if (!user) return html(res, 200, loginPage(''));

    if (req.method === 'POST') {
      if (form.action === 'chpw') {
        const okPw = await users.verifyPassword(String(form.current || ''), user.password_hash);
        if (!okPw) { await sleep(1000); return accountPage(res, user, 'Senha atual incorreta.', false); }
        if (form.password !== form.password2) return accountPage(res, user, 'As senhas não conferem.', false);
        const err = users.checkPassword(String(form.password || ''));
        if (err) return accountPage(res, user, err, false);
        await users.changePassword(user.id, String(form.password));
        return redirect(res, '/admin', { 'Set-Cookie': sec.sessionCookie(req, '', 0) });   // sessões antigas caem; entre de novo
      }
      if (user.role !== 'owner') return html(res, 403, 'Sem permissão.');
      if (form.action === 'invite') {
        const r = await users.invite(form.email, form.name);
        if (r.error) return teamPage(res, user, r.error);
        const t = await users.createToken(r.user.id, 'invite');
        return teamPage(res, user, '', { url: `${baseUrl(req)}/admin?setup=${t}`, email: r.user.email, hours: 72 });
      }
      const target = await users.byId(parseInt(form.uid, 10) || 0);
      if (!target) return teamPage(res, user, 'Conta não encontrada.');
      if (form.action === 'reset') {
        if (!target.active) return teamPage(res, user, 'Conta desativada.');
        const t = await users.createToken(target.id, target.password_hash ? 'reset' : 'invite');
        return teamPage(res, user, '', { url: `${baseUrl(req)}/admin?setup=${t}`, email: target.email, hours: target.password_hash ? 24 : 72 });
      }
      if (form.action === 'toggle') {
        if (target.id === user.id || target.role === 'owner') return teamPage(res, user, 'Esta conta não pode ser desativada.');
        await users.setActive(target.id, form.active === '1');
        return teamPage(res, user);
      }
      return html(res, 400, 'Ação inválida.');
    }

    if (q.team !== undefined) return user.role === 'owner' ? await teamPage(res, user) : html(res, 403, 'Sem permissão.');
    if (q.account !== undefined) return accountPage(res, user);
    if (q.export !== undefined) return await exportCsv(res, user, q.export);
    if (q.id !== undefined) return await detailPage(res, user, Math.max(0, parseInt(q.id, 10) || 0));
    return await overviewPage(res, user, q.mode || '');
  } catch (e) {
    console.error('[arvorecer]', e && e.message);
    html(res, 500, 'Erro interno no painel. Veja os logs da Vercel.');
  }
};
