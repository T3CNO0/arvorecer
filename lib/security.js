/* =============================================================================
   ARVORECER — SEGURANÇA  (lib/security.js)
   -----------------------------------------------------------------------------
   • Hash do IP (o IP puro nunca é salvo) e comparação em tempo constante;
   • sessão do painel por COOKIE ASSINADO: "<id>.<versão>.<expiração>.<assinatura>".
     A cada requisição a conta é lida no banco: se foi desativada ou trocou a senha
     (versão diferente), a sessão antiga deixa de valer na hora;
   • limite de tentativas erradas de login (por IP e por e-mail);
   • verificação de origem em formulários (defesa extra contra CSRF).
   ============================================================================= */
'use strict';

const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const users = require('./users');
const { clientIp, parseCookies, isHttps } = require('./http');

const COOKIE_NAME = 'arvorecer_admin';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Hash do IP + sal (32 caracteres). */
function ipHash(req) { return sha(cfg.ipSalt() + '|' + clientIp(req)).slice(0, 32); }
/** Hash do e-mail + sal, para limitar tentativas contra uma mesma conta (sem guardar o e-mail). */
function emailKey(email) { return 'e' + sha(cfg.ipSalt() + '|' + users.normEmail(email)).slice(0, 31); }

function safeEqual(a, b) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
}

/** O painel precisa de SESSION_SECRET; contas são criadas via ADMIN_EMAIL + ADMIN_PASSWORD na 1ª vez. */
function adminEnabled() { return cfg.sessionSecret() !== ''; }

function signingKey() { return crypto.createHash('sha256').update('arvorecer-session|' + cfg.sessionSecret()).digest(); }
function sign(payload) { return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url'); }

function makeSession(user) {
  const exp = Date.now() + cfg.ADMIN_SESSION_HOURS * 3600 * 1000;
  const body = `${user.id}.${user.pw_version}.${exp}`;
  return `${body}.${sign(body)}`;
}

/** Confere o cookie e devolve a conta (ativa, mesma versão) ou null. */
async function currentUser(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4 || !parts.slice(0, 3).every((x) => /^\d+$/.test(x))) return null;
  const body = parts.slice(0, 3).join('.');
  const expected = sign(body);
  if (parts[3].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[3]), Buffer.from(expected))) return null;
  if (Number(parts[2]) <= Date.now()) return null;
  const u = await users.byId(Number(parts[0]));
  if (!u || !u.active || !u.password_hash || u.pw_version !== Number(parts[1])) return null;
  return u;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/** Tentativas erradas recentes deste visitante OU contra esta conta. */
async function recentFailures(req, email) {
  const keys = [ipHash(req)]; if (email) keys.push(emailKey(email));
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM admin_login_failures
      WHERE ip_hash = ANY($1::text[]) AND created_at >= now() - ($2 || ' minutes')::interval`,
    [keys, String(cfg.ADMIN_FAILURE_WINDOW_MIN)]);
  return r.rows[0].n;
}
async function recordFailure(req, email) {
  await db.query('INSERT INTO admin_login_failures (ip_hash) VALUES ($1)', [ipHash(req)]);
  if (email) await db.query('INSERT INTO admin_login_failures (ip_hash) VALUES ($1)', [emailKey(email)]);
  await db.query(`DELETE FROM admin_login_failures WHERE created_at < now() - interval '1 day'`);
}

/**
 * Em POST, só aceitamos pedidos vindos do próprio site.
 * 1) Sec-Fetch-Site (enviado pelos navegadores atuais e impossível de forjar por uma página):
 *    "same-origin" ou "none" passam; "cross-site"/"same-site" são recusados.
 * 2) Sem esse cabeçalho (navegador antigo, ferramentas), confere o Origin contra o Host.
 *    (Origin "null" só aparece com Referrer-Policy: no-referrer; o painel usa same-origin.)
 */
function sameOrigin(req) {
  const fs = req.headers['sec-fetch-site'];
  if (fs) return fs === 'same-origin' || fs === 'none';
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (_) { return false; }
}

module.exports = { COOKIE_NAME, ipHash, emailKey, safeEqual, adminEnabled, makeSession, currentUser, sessionCookie, recentFailures, recordFailure, sameOrigin };
