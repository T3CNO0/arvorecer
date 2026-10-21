/* =============================================================================
   ARVORECER — CONTAS DO PAINEL  (lib/users.js)
   -----------------------------------------------------------------------------
   Administrador principal (owner) e professores (teacher): criação por convite,
   senha com hash scrypt, links de definição/redefinição de senha de uso único.
   Sem envio de e-mail: o link é mostrado ao administrador principal, que o entrega.
   ============================================================================= */
'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const MIN_PASSWORD = 10;
const TOKEN_HOURS = { invite: 72, reset: 24 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/* ---------- senha: scrypt com sal aleatório ---------- */
function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key))));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt)).toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const got = await scrypt(password, Buffer.from(s, 'base64'));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
// Hash falso: usado quando o e-mail não existe, para o tempo de resposta não revelar quem tem conta.
let _dummy = null;
async function dummyVerify(password) {
  if (!_dummy) _dummy = await hashPassword('nao-existe-' + crypto.randomBytes(8).toString('hex'));
  await verifyPassword(password, _dummy);
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (pw.length > 200) return 'Senha longa demais.';
  return null;
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function validEmail(e) { return EMAIL_RE.test(e) && e.length <= 254; }

/* ---------- código do professor (ex.: "maria-4821") ---------- */
function slug(name) {
  const base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  return base || 'prof';
}
async function uniqueCode(name, q = db) {
  for (let i = 0; i < 20; i++) {
    const code = `${slug(name)}-${String(crypto.randomInt(1000, 10000))}`;
    const r = await q.query('SELECT 1 FROM users WHERE lower(code) = $1', [code]);
    if (!r.rows.length) return code;
  }
  throw new Error('Não foi possível gerar um código único.');
}

/* ---------- consultas ---------- */
async function byEmail(email) { return (await db.query('SELECT * FROM users WHERE email = $1', [normEmail(email)])).rows[0] || null; }
async function byId(id) { return (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null; }
async function byCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  return (await db.query('SELECT * FROM users WHERE lower(code) = $1 AND active', [c])).rows[0] || null;
}
async function listAll() { return (await db.query('SELECT * FROM users ORDER BY role DESC, id')).rows; }

/** Primeiro acesso: se não existe nenhuma conta, cria o administrador principal a partir do ambiente. */
async function bootstrapOwner() {
  const n = (await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
  if (n > 0) return;
  const email = cfg.adminEmail(), pw = cfg.adminPassword();
  if (!validEmail(email) || checkPassword(pw)) return;   // sem ADMIN_EMAIL/ADMIN_PASSWORD válidos, painel segue desativado
  const hash = await hashPassword(pw);
  try {
    await db.query(`INSERT INTO users (email, name, code, role, password_hash) VALUES ($1,$2,$3,'owner',$4)`,
      [email, 'Administrador', await uniqueCode('admin'), hash]);
  } catch (e) { /* outra instância criou ao mesmo tempo: tudo bem */ }
}
async function hasAnyUser() { return (await db.query('SELECT 1 FROM users LIMIT 1')).rows.length > 0; }

/** Convida um professor (ainda sem senha). Retorna { user } ou { error }. */
async function invite(email, name) {
  email = normEmail(email); name = String(name || '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 80);
  if (!validEmail(email)) return { error: 'E-mail inválido.' };
  if (!name) return { error: 'Informe o nome.' };
  if (await byEmail(email)) return { error: 'Já existe uma conta com este e-mail.' };
  const r = await db.query(`INSERT INTO users (email, name, code, role) VALUES ($1,$2,$3,'teacher') RETURNING *`,
    [email, name, await uniqueCode(name)]);
  return { user: r.rows[0] };
}

/* ---------- tokens de convite / redefinição ---------- */
const th = (t) => crypto.createHash('sha256').update(t).digest('hex');
/** Cria um token novo (invalida os anteriores do mesmo usuário). Devolve o texto puro — mostrado uma única vez. */
async function createToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await db.query(`INSERT INTO user_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [userId, th(token), purpose, String(TOKEN_HOURS[purpose])]);
  return token;
}
/** Token válido (existe, não usado, não expirado, conta ativa) → usuário; senão null. */
async function userForToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const r = await db.query(
    `SELECT u.* FROM user_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.active`, [th(token)]);
  return r.rows[0] || null;
}
/** Define a senha usando o token (uso único). Retorna mensagem de erro ou null. */
async function setPasswordWithToken(token, password) {
  const err = checkPassword(password); if (err) return err;
  const user = await userForToken(token); if (!user) return 'Link inválido ou expirado.';
  const hash = await hashPassword(password);
  const used = await db.query('UPDATE user_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING id', [th(token)]);
  if (!used.rows.length) return 'Link inválido ou expirado.';
  await db.query('UPDATE users SET password_hash = $1, pw_version = pw_version + 1 WHERE id = $2', [hash, user.id]);
  return null;
}
async function changePassword(userId, newPassword) {
  await db.query('UPDATE users SET password_hash = $1, pw_version = pw_version + 1 WHERE id = $2', [await hashPassword(newPassword), userId]);
}
async function setActive(userId, active) {
  await db.query('UPDATE users SET active = $1, pw_version = pw_version + 1 WHERE id = $2', [active, userId]);
}

module.exports = { MIN_PASSWORD, hashPassword, verifyPassword, dummyVerify, checkPassword, normEmail, validEmail,
  byEmail, byId, byCode, listAll, bootstrapOwner, hasAnyUser, invite, createToken, userForToken, setPasswordWithToken, changePassword, setActive };
