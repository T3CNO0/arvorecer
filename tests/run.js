/* =============================================================================
   ARVORECER — testes automáticos (npm test)
   Sobe as funções com um Postgres em WebAssembly e confere:
     1) pontuação idêntica à versão PHP (se PHP_PARITY_DIR apontar para a pasta PHP);
     2) todas as defesas (honeypot, consentimento, validações, integridade, limites);
     3) painel (login, cookie, bloqueio por tentativas, CSV, escape de HTML).
   ============================================================================= */
'use strict';
process.env.ADMIN_EMAIL = 'dono@exemplo.com';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.SESSION_SECRET = 'segredo-de-teste-abcdef';
process.env.IP_SALT = 'sal-de-teste';
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL;

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const assert = require('assert');
const root = path.join(__dirname, '..');
const db = require('../lib/db');
const key = require('../lib/answer_key');

let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✘', name, extra === undefined ? '' : JSON.stringify(extra)); } }

/* ---- servidor local que imita a Vercel ---- */
function startNode(port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x'); let p = u.pathname;
      if (p === '/admin') p = '/api/admin';
      const m = p.match(/^\/api\/([a-z_]+)$/);
      if (!m) { res.statusCode = 404; return res.end('404'); }   // só funções; arquivos privados nunca são servidos
      Promise.resolve(require('../api/' + m[1] + '.js')(req, res)).catch((e) => { res.statusCode = 500; res.end(String(e)); });
    }).listen(port, () => resolve(s));
  });
}
function request(base, method, p, { body, headers, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'Content-Type': (headers && headers['Content-Type']) || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, text, json: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

/* ---- geração de respostas ---- */
const bank = JSON.parse(execSync(`node -e "const s=require('fs').readFileSync('${root}/tools/question_bank.source.js','utf8');process.stdout.write(JSON.stringify(new Function(s+';return QUESTION_BANK')()))"`, { maxBuffer: 1 << 26 }).toString());
const med = JSON.parse(fs.readFileSync(path.join(root, 'tools/mediated_items.json'), 'utf8')).items;
const rnd = (n) => Math.floor(Math.random() * n);
function buildAuto(groups, pRight) {
  const ids = [], ans = [];
  for (const g of groups) {
    const q = bank[g][rnd(bank[g].length)]; const c = key.autonomo.items[q.id].a;
    ids.push(q.id); ans.push(Math.random() < pRight ? c : q.o.map((o) => o.id).filter((x) => x !== c)[0]);
  }
  return { ids, ans };
}
const BASE = { mode: 'autonomo', consent: true, ageRange: '25-34', education: 'medio_completo', region: 'Sul', arrivalSource: 'outro', website: '', durationSeconds: 300 };
function autoPayload(total, p) {
  const groups = total === 50 ? [...Array(50).keys()] : key.autonomo.short;
  const { ids, ans } = buildAuto(groups, p);
  return { ...BASE, total, questionIds: ids, answers: ans };
}
function medPayload(p) {
  const items = med.map((it) => {
    const right = Math.random() < p; let resp;
    if (it.type === 'choice') resp = right ? it.answer : it.options.find((o) => o.id !== it.answer).id;
    else if (it.type === 'build') resp = right ? it.words : it.words.slice().reverse();
    else resp = right ? 'ok' : ['parcial', 'nao'][rnd(2)];
    return { id: it.id, response: resp };
  });
  return { mode: 'mediado', consent: true, ageRange: '6-9', education: 'fundamental_incompleto', region: 'Norte', studentCode: 'José', teacherCode: 'Natan', notes: 'troca b/d', durationSeconds: 600, items };
}
const ipH = (n) => ({ 'x-real-ip': '10.0.' + Math.floor(n / 250) + '.' + (n % 250 + 1) });

(async () => {
  db.setAdapter(await require('../tools/pglite-adapter')());
  const NODE = 'http://127.0.0.1:3111';
  const server = await startNode(3111);

  /* ===== 1) PARIDADE COM O PHP ===== */
  const phpDir = process.env.PHP_PARITY_DIR;
  let php = null, tmp = null;
  if (phpDir) {
    console.log('\n[1] Paridade de pontuação: Node × PHP');
    tmp = fs.mkdtempSync('/tmp/arv-php-'); execSync(`cp -r "${phpDir}/." "${tmp}" && rm -rf "${tmp}/data"`);
    php = spawn('php', ['-S', '127.0.0.1:3112', '-t', tmp], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
    const PHP = 'http://127.0.0.1:3112/';
    const wn = (await request(NODE, 'GET', '/api/weights')).json, wp = (await request(PHP, 'GET', 'weights.php')).json;
    ok(JSON.stringify(wn) === JSON.stringify(wp), 'tabela de competências/pesos idêntica (weights)');
    let diffs = 0, n = 0;
    const cases = [];
    for (let i = 0; i < 12; i++) cases.push(autoPayload(30, Math.random()), autoPayload(50, Math.random()), medPayload(Math.random()));
    for (const c of cases) {
      const a = (await request(NODE, 'POST', '/api/save_result', { body: c, headers: ipH(900 + n) })).json;
      const b = (await request(PHP, 'POST', 'save_result.php', { body: c })).json;
      n++;
      const strip = (r) => ({ ok: r.ok, mode: r.mode, score: r.score, scoreRaw: r.scoreRaw, correct: r.correct, total: r.total, breakdown: r.breakdown });
      try { assert.deepStrictEqual(strip(a), strip(b)); } catch (e) { diffs++; if (diffs < 3) console.log('   DIFERENÇA', JSON.stringify(strip(a)).slice(0, 300), JSON.stringify(strip(b)).slice(0, 300)); }
    }
    ok(diffs === 0, `${n} testes (30/50 questões e fundamental) com resultado idêntico ao PHP`, { diffs });
    // mesmos erros para os mesmos ataques
    const atk = [
      { ...autoPayload(30, 1), consent: false }, { ...autoPayload(30, 1), ageRange: 'x' },
      { ...autoPayload(30, 1), total: 40 }, { ...autoPayload(30, 1), answers: autoPayload(30, 1).answers.slice(1) },
      { ...medPayload(1), items: medPayload(1).items.slice(1) }, { ...autoPayload(30, 1), arrivalSource: 'zzz' },
    ];
    let same = 0;
    for (const c of atk) {
      const a = await request(NODE, 'POST', '/api/save_result', { body: c, headers: ipH(990) });
      const b = await request(PHP, 'POST', 'save_result.php', { body: c });
      if (a.status === b.status && a.json.error === b.json.error) same++; else console.log('   erro diferente:', a.status, a.json, b.status, b.json);
    }
    ok(same === atk.length, 'ataques/entradas inválidas rejeitados com o mesmo status e mensagem do PHP', { same });
  } else console.log('\n[1] (pulado: defina PHP_PARITY_DIR para comparar com a versão PHP)');

  /* ===== 2) SEGURANÇA DA API ===== */
  console.log('\n[2] Segurança do envio de resultados');
  const count = async () => (await request(NODE, 'GET', '/api/respondentes')).json.responseCount;
  const c0 = await count();
  let r = await request(NODE, 'POST', '/api/save_result', { body: { ...autoPayload(30, 1), website: 'http://spam' }, headers: ipH(1) });
  ok(r.status === 200 && r.json.ignored === true && (await count()) === c0, 'honeypot: robô recebe ok mas nada é gravado');
  r = await request(NODE, 'GET', '/api/save_result'); ok(r.status === 405, 'GET recusado (405)');
  r = await request(NODE, 'POST', '/api/save_result', { body: { ...autoPayload(30, 1), consent: 'true' }, headers: ipH(2) }); ok(r.status === 400, 'consentimento precisa ser exatamente true');
  r = await request(NODE, 'POST', '/api/save_result', { body: { ...autoPayload(30, 1), region: 'Marte' }, headers: ipH(2) }); ok(r.status === 400, 'região fora da lista recusada');
  r = await request(NODE, 'POST', '/api/save_result', { body: '{nao é json', headers: ipH(2) }); ok(r.status === 400, 'JSON inválido recusado');
  r = await request(NODE, 'POST', '/api/save_result', { body: '[1,2]', headers: ipH(2) }); ok(r.status === 400, 'JSON que não é objeto recusado');
  r = await request(NODE, 'POST', '/api/save_result', { body: 'x'.repeat(250000), headers: ipH(2) }); ok(r.status === 413 || r.status === 400, 'corpo acima de 200 KB recusado', r.status);
  let p = autoPayload(30, 1); p.questionIds[1] = p.questionIds[0]; p.answers[1] = p.answers[0];
  r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(2) }); ok(r.status === 400, 'duas questões do mesmo grupo recusadas', r.json);
  p = autoPayload(30, 1); p.questionIds[0] = bank[(key.autonomo.short.includes(0) ? 1 : 0)][0].id; // grupo fora da versão curta
  r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(2) }); ok(r.status === 400, 'conjunto de grupos errado para 30 questões recusado', r.json);
  p = autoPayload(30, 1); p.answers[0] = 'z'; r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(2) }); ok(r.status === 400, 'resposta fora de a–d recusada');
  p = autoPayload(30, 1); p.questionIds[0] = "q01a'; DROP TABLE submissions;--"; r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(2) }); ok(r.status === 400 && (await count()) === c0, 'id de questão malicioso recusado; banco intacto');
  p = medPayload(1); p.items[0].id = p.items[1].id; r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(2) }); ok(r.status === 400, 'item repetido no teste fundamental recusado');
  p = medPayload(1); p.notes = 'a\u0000b<script>' + 'x'.repeat(3000); p.studentCode = '=SOMA(1;1)';
  r = await request(NODE, 'POST', '/api/save_result', { body: p, headers: ipH(3) }); ok(r.status === 200 && r.json.score === 100, 'teste fundamental todo certo = 100', r.json && r.json.score);
  r = await request(NODE, 'POST', '/api/save_result', { body: { ...medPayload(1), items: medPayload(1).items.map((i) => (typeof i.response === 'string' && i.response === 'ok' ? { ...i, response: 'parcial' } : i)) }, headers: ipH(3) });
  ok(r.status === 200 && r.json.score < 100 && r.json.scoreRaw === r.json.score, 'parcial vale 0,5 (score menor que 100)', r.json && r.json.score);
  ok(!JSON.stringify(r.json).includes('"a":') && !r.text.includes('gabarito'), 'resposta nunca traz o gabarito');
  // limite de envios por hora (60)
  let last; for (let i = 0; i < 61; i++) last = await request(NODE, 'POST', '/api/save_result', { body: medPayload(0.5), headers: ipH(5) });
  ok(last.status === 429, 'limite de 60 envios/hora por visitante (61º recebe 429)', last.status);
  r = await request(NODE, 'POST', '/api/save_result', { body: medPayload(0.5), headers: ipH(6) }); ok(r.status === 200, 'outro visitante não é afetado pelo limite');
  const rows = (await db.query('SELECT ip_hash FROM submissions LIMIT 3')).rows;
  ok(rows.every((x) => /^[0-9a-f]{32}$/.test(x.ip_hash) && !x.ip_hash.includes('10.0')), 'IP gravado só como hash');
  r = await request(NODE, 'POST', '/api/save_result', { body: medPayload(1), headers: ipH(7) });
  ok(r.headers['cache-control'] === 'no-store' && r.headers['x-content-type-options'] === 'nosniff', 'cabeçalhos de segurança na resposta da API');
  r = await request(NODE, 'GET', '/lib/answer_key.js'); ok(r.status === 404, 'gabarito não é acessível pela web');

  /* ===== 3) PAINEL COM CONTAS ===== */
  console.log('\n[3] Painel /admin com contas (administrador principal e professores)');
  const users = require('../lib/users'), sec = require('../lib/security');
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const enc = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const A = (q, o) => request(NODE, (o && o.method) || 'GET', '/admin' + (q || ''), o);
  const post = (o, cookie, ip) => A('', { method: 'POST', body: enc(o), headers: { ...FORM, ...(cookie ? { cookie } : {}), ...ipH(ip || 30) } });
  const cookieOf = (r) => ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const loginAs = async (email, pw, ip) => { const r = await post({ action: 'login', email, password: pw }, null, ip); return { r, cookie: cookieOf(r) }; };
  const OWNER = 'dono@exemplo.com', OPW = 'senha-de-teste-123';

  r = await A(''); ok(r.status === 200 && r.text.includes('type="email"') && r.text.includes('type="password"') && !r.text.includes('Últimos'), 'sem login: só o formulário (e-mail + senha)');
  ok((r.headers['content-security-policy'] || '').includes("default-src 'none'"), 'painel com CSP restrita');
  ok((await db.query('SELECT role, password_hash FROM users')).rows.some((u) => u.role === 'owner' && u.password_hash.startsWith('scrypt$')), '1º administrador criado do ambiente, com senha em scrypt (nunca em texto)');

  let t0 = Date.now(); const bad1 = await loginAs(OWNER, 'errada', 31); const d1 = Date.now() - t0;
  t0 = Date.now(); const bad2 = await loginAs('ninguem@exemplo.com', 'errada', 32); const d2 = Date.now() - t0;
  ok(bad1.r.status === 401 && d1 >= 950 && !bad1.cookie, 'senha errada: 401, atraso de 1 s, sem sessão');
  ok(bad2.r.status === 401 && bad2.r.text.includes('E-mail ou senha incorretos') && bad1.r.text.includes('E-mail ou senha incorretos') && Math.abs(d1 - d2) < 400, 'e-mail inexistente: mesma resposta e mesmo tempo (não revela quem tem conta)', [d1, d2]);

  const own = await loginAs(OWNER, OPW, 33); const sc = (own.r.headers['set-cookie'] || [])[0] || '';
  ok(own.r.status === 303 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), 'administrador entra: cookie HttpOnly + SameSite=Strict', sc);
  const oc = own.cookie;
  r = await A('', { headers: { cookie: oc } }); ok(r.status === 200 && r.text.includes('testes registrados') && r.text.includes('Equipe'), 'visão geral do administrador principal');

  // --- convite
  r = await post({ action: 'invite', name: 'Maria Souza', email: 'Maria@Escola.com' }, oc);
  const m1 = r.text.match(/\/admin\?setup=([\w-]+)/); ok(r.status === 200 && m1, 'convite gera link de uso único');
  ok(!(await db.query('SELECT 1 FROM user_tokens WHERE token_hash = $1', [m1[1]])).rows.length, 'banco guarda só o hash do token, não o token');
  const teacher = (await users.byEmail('maria@escola.com')); ok(teacher && /^maria-\d{4}$/.test(teacher.code) && !teacher.password_hash, 'professora criada (e-mail em minúsculas), código gerado, ainda sem senha', teacher && teacher.code);
  r = await post({ action: 'invite', name: 'Outra', email: 'maria@escola.com' }, oc); ok(r.text.includes('Já existe'), 'e-mail repetido recusado');
  r = await post({ action: 'invite', name: 'X', email: 'nao-e-email' }, oc); ok(r.text.includes('E-mail inválido'), 'e-mail inválido recusado');
  const tl = await loginAs('maria@escola.com', 'qualquer-coisa-123', 34); ok(tl.r.status === 401, 'conta sem senha definida não entra');
  r = await A('?setup=' + m1[1]); ok(r.status === 200 && r.text.includes('maria@escola.com'), 'link abre a tela de definir senha');
  r = await A('?setup=token-falso-token-falso-token'); ok(r.status === 400, 'token inventado recusado');
  r = await post({ action: 'setup', token: m1[1], password: 'curta', password2: 'curta' }); ok(r.status === 400 && r.text.includes('pelo menos'), 'senha curta recusada');
  r = await post({ action: 'setup', token: m1[1], password: 'senha-da-maria-1', password2: 'diferente-12345' }); ok(r.status === 400 && r.text.includes('não conferem'), 'senhas diferentes recusadas');
  r = await post({ action: 'setup', token: m1[1], password: 'senha-da-maria-1', password2: 'senha-da-maria-1' }); ok(r.status === 200 && r.text.includes('Senha definida'), 'senha definida pelo link');
  r = await post({ action: 'setup', token: m1[1], password: 'outra-senha-9999', password2: 'outra-senha-9999' }); ok(r.status === 400, 'link não pode ser usado duas vezes');
  const tc = await loginAs('MARIA@escola.com', 'senha-da-maria-1', 35); ok(tc.r.status === 303, 'professora entra (e-mail sem diferenciar maiúsculas)');
  const mc = tc.cookie;

  // --- testes ligados ao professor
  const mk = (teacherCode, student) => ({ ...medPayload(1), teacherCode, studentCode: student, notes: '<script>alert(1)</script>' });
  r = await request(NODE, 'POST', '/api/save_result', { body: mk(teacher.code.toUpperCase(), '=SOMA(1;1)'), headers: ipH(40) }); ok(r.status === 200, 'teste com o código da professora (maiúsculas) é aceito');
  const linked = (await db.query('SELECT id FROM submissions WHERE student_code = $1 AND teacher_id IS NOT NULL ORDER BY id DESC', ['=SOMA(1;1)'])).rows[0].id;
  r = await request(NODE, 'POST', '/api/save_result', { body: mk('Outro Professor', 'Aluno Alheio'), headers: ipH(40) });
  const alheio = (await db.query('SELECT id, teacher_id FROM submissions WHERE student_code = $1', ['Aluno Alheio'])).rows[0];
  ok((await db.query('SELECT teacher_id FROM submissions WHERE id = $1', [linked])).rows[0].teacher_id === teacher.id && alheio.teacher_id === null, 'teste fica ligado à professora só quando o código confere');
  r = await A('', { headers: { cookie: mc } });
  ok(r.status === 200 && r.text.includes('=SOMA') && !r.text.includes('Aluno Alheio') && /<b>1<\/b><span>testes registrados/.test(r.text), 'professora vê só o próprio teste (1) na visão geral');
  ok(!r.text.includes('Equipe'), 'professora não vê o menu Equipe');
  r = await A('?id=' + alheio.id, { headers: { cookie: mc } }); ok(r.status === 404, 'professora não abre teste de outro (404)');
  r = await A('?id=' + linked, { headers: { cookie: mc } }); ok(r.status === 200 && r.text.includes('&lt;script&gt;') && !r.text.includes('<script>'), 'professora abre o seu; HTML escapado (XSS)');
  r = await A('?id=' + alheio.id, { headers: { cookie: oc } }); ok(r.status === 200, 'administrador principal abre qualquer teste');
  r = await A('?export=submissions', { headers: { cookie: mc } }); ok(r.status === 200 && r.text.startsWith('﻿') && r.text.includes("'=SOMA(1;1)") && !r.text.includes('Aluno Alheio'), 'CSV da professora: só os dela, com proteção contra fórmula');
  r = await A('?export=answers', { headers: { cookie: mc } }); const nlines = r.text.trim().split('\n').length; ok(r.status === 200 && nlines === 1 + 34, 'CSV de respostas da professora: só as 34 respostas do teste dela', nlines);
  r = await A('?export=submissions', { headers: { cookie: oc } }); ok(r.text.includes('Aluno Alheio') && r.text.includes("'=SOMA(1;1)"), 'CSV do administrador principal: tudo');
  r = await A('?export=submissions'); ok(!/text\/csv/.test(r.headers['content-type'] || ''), 'CSV exige login');

  // --- permissões
  r = await A('?team=1', { headers: { cookie: mc } }); ok(r.status === 403, 'professora não acessa a equipe (403)');
  r = await post({ action: 'invite', name: 'Intruso', email: 'intruso@x.com' }, mc); ok(r.status === 403 && !(await users.byEmail('intruso@x.com')), 'professora não consegue convidar ninguém');
  r = await post({ action: 'toggle', uid: String(1), active: '0' }, mc); ok(r.status === 403, 'professora não consegue desativar contas');
  r = await A('', { method: 'POST', body: enc({ action: 'invite', name: 'Z', email: 'z@x.com' }), headers: { ...FORM, cookie: oc, origin: 'https://site-malicioso.com', host: 'localhost:3111', ...ipH(30) } }); ok(r.status === 403 && !(await users.byEmail('z@x.com')), 'formulário de outra origem recusado (anti-CSRF)');
  r = await A('', { method: 'POST', body: enc({ action: 'invite', name: 'Z', email: 'z2@x.com' }), headers: { ...FORM, cookie: oc, 'sec-fetch-site': 'cross-site', ...ipH(30) } }); ok(r.status === 403 && !(await users.byEmail('z2@x.com')), 'Sec-Fetch-Site cross-site recusado');
  r = await A('', { method: 'POST', body: enc({ action: 'invite', name: 'Z', email: 'z3@x.com' }), headers: { ...FORM, cookie: oc, origin: 'null', 'sec-fetch-site': 'same-origin', ...ipH(30) } }); ok(r.status === 200 && (await users.byEmail('z3@x.com')), 'formulário legítimo do navegador (Origin: null + same-origin) é aceito');
  r = await A(''); ok(r.headers['referrer-policy'] === 'same-origin', 'painel usa Referrer-Policy same-origin');

  // --- cookie forjado / adulterado
  const forged = 'arvorecer_admin=1.1.' + (Date.now() + 1e7) + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  r = await A('', { headers: { cookie: forged } }); ok(r.text.includes('type="password"'), 'cookie forjado recusado');
  r = await A('', { headers: { cookie: mc.replace(/=(\d+)\./, '=1.') } }); ok(r.text.includes('type="password"'), 'cookie de professora adulterado para virar o id do administrador é recusado');

  // --- troca de senha pela própria conta
  r = await post({ action: 'chpw', current: 'errada-errada', password: 'nova-senha-maria-2', password2: 'nova-senha-maria-2' }, mc); ok(r.text.includes('Senha atual incorreta'), 'troca de senha exige a senha atual');
  r = await post({ action: 'chpw', current: 'senha-da-maria-1', password: 'nova-senha-maria-2', password2: 'nova-senha-maria-2' }, mc);
  ok(r.status === 303, 'senha trocada');
  r = await A('', { headers: { cookie: mc } }); ok(r.text.includes('type="password"'), 'sessão antiga cai depois de trocar a senha');
  ok((await loginAs('maria@escola.com', 'senha-da-maria-1', 36)).r.status === 401 && (await loginAs('maria@escola.com', 'nova-senha-maria-2', 36)).r.status === 303, 'senha antiga não vale; a nova vale');

  // --- recuperação de senha (link gerado pelo administrador)
  const mc2 = (await loginAs('maria@escola.com', 'nova-senha-maria-2', 37)).cookie;
  r = await post({ action: 'reset', uid: String(teacher.id) }, oc); const m2 = r.text.match(/\/admin\?setup=([\w-]+)/); ok(m2, 'administrador gera link de nova senha');
  r = await post({ action: 'reset', uid: String(teacher.id) }, oc); const m3 = r.text.match(/\/admin\?setup=([\w-]+)/);
  r = await post({ action: 'setup', token: m2[1], password: 'senha-do-link-antigo', password2: 'senha-do-link-antigo' }); ok(r.status === 400, 'gerar novo link invalida o anterior');
  r = await post({ action: 'setup', token: m3[1], password: 'senha-recuperada-77', password2: 'senha-recuperada-77' }); ok(r.status === 200, 'senha recuperada pelo link');
  r = await A('', { headers: { cookie: mc2 } }); ok(r.text.includes('type="password"'), 'sessão aberta antes da recuperação é derrubada');
  const mc3 = (await loginAs('maria@escola.com', 'senha-recuperada-77', 38)).cookie; ok(mc3, 'entra com a senha recuperada');
  await db.query(`UPDATE user_tokens SET expires_at = now() - interval '1 minute'`);
  r = await post({ action: 'reset', uid: String(teacher.id) }, oc); const m4 = r.text.match(/\/admin\?setup=([\w-]+)/);
  await db.query(`UPDATE user_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash <> 'x'`);
  r = await A('?setup=' + m4[1]); ok(r.status === 400, 'link expirado recusado');

  // --- desativar
  r = await post({ action: 'toggle', uid: String(teacher.id), active: '0' }, oc); ok(r.status === 200, 'administrador desativa a professora');
  r = await A('', { headers: { cookie: mc3 } }); ok(r.text.includes('type="password"'), 'sessão da conta desativada cai na hora');
  ok((await loginAs('maria@escola.com', 'senha-recuperada-77', 39)).r.status === 401, 'conta desativada não entra');
  r = await post({ action: 'toggle', uid: '1', active: '0' }, oc); ok(r.text.includes('não pode ser desativada'), 'administrador principal não pode ser desativado');
  await request(NODE, 'POST', '/api/save_result', { body: mk(teacher.code, 'Aluno Depois'), headers: ipH(41) });
  ok((await db.query('SELECT teacher_id FROM submissions WHERE student_code = $1', ['Aluno Depois'])).rows[0].teacher_id === null, 'código de conta desativada não liga mais testes');
  await post({ action: 'toggle', uid: String(teacher.id), active: '1' }, oc);
  ok((await loginAs('maria@escola.com', 'senha-recuperada-77', 39)).r.status === 303, 'reativada, volta a entrar');

  // --- bloqueio por tentativas (por visitante e por conta)
  for (let i = 0; i < 10; i++) await db.query('INSERT INTO admin_login_failures (ip_hash) VALUES ($1)', [sec.ipHash({ headers: { 'x-real-ip': '10.9.9.9' } })]);
  r = await loginAs(OWNER, OPW, 0); r = await A('', { method: 'POST', body: enc({ action: 'login', email: OWNER, password: OPW }), headers: { ...FORM, 'x-real-ip': '10.9.9.9' } });
  ok(r.status === 429 && !cookieOf(r), 'após 10 erros do mesmo visitante, até a senha certa fica bloqueada (429)');
  for (let i = 0; i < 10; i++) await db.query('INSERT INTO admin_login_failures (ip_hash) VALUES ($1)', [sec.emailKey('maria@escola.com')]);
  r = await post({ action: 'login', email: 'maria@escola.com', password: 'senha-recuperada-77' }, null, 50); ok(r.status === 429, 'após 10 erros contra uma conta, ela é bloqueada mesmo vindo de outro IP');
  r = await loginAs(OWNER, OPW, 51); ok(r.r.status === 303, 'outras contas/visitantes entram normalmente');

  r = await A('?logout=1', { headers: { cookie: oc } }); ok(r.status === 303 && /Max-Age=0/.test((r.headers['set-cookie'] || [''])[0]), 'sair limpa o cookie');
  const savedSecret = process.env.SESSION_SECRET; process.env.SESSION_SECRET = '';
  r = await A(''); ok(r.status === 403, 'sem SESSION_SECRET o painel fica desativado (403)'); process.env.SESSION_SECRET = savedSecret;

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  server.close(); if (php) php.kill(); if (tmp) execSync(`rm -rf "${tmp}"`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
