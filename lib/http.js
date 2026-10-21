/* =============================================================================
   ARVORECER — UTILITÁRIOS HTTP  (lib/http.js)
   -----------------------------------------------------------------------------
   Respostas padronizadas (JSON/HTML/CSV) com cabeçalhos de segurança, leitura do
   corpo da requisição COM LIMITE de tamanho, cookies e IP do visitante.
   ============================================================================= */
'use strict';

const cfg = require('./config');

/** Cabeçalhos de segurança aplicados a toda resposta das funções. */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Erro com código HTTP, para interromper o fluxo e responder de forma limpa. */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function applyHeaders(res, extra) {
  const all = { ...BASE_HEADERS, ...(extra || {}) };
  for (const [k, v] of Object.entries(all)) res.setHeader(k, v);
}

/** Responde JSON. */
function json(res, status, data, extraHeaders) {
  applyHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

/** Responde HTML (usado só pelo painel) com política de segurança de conteúdo restrita. */
function html(res, status, body, extraHeaders) {
  applyHeaders(res, {
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'same-origin',   // o navegador envia Origin correto nos formulários; nada vaza para outros sites
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...(extraHeaders || {}),
  });
  res.statusCode = status;
  res.end(body);
}

/** Lê o corpo cru da requisição, recusando acima do limite (padrão: MAX_BODY_BYTES). */
function readBody(req, limit) {
  const max = limit || cfg.MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) return reject(new HttpError(413, 'Corpo da requisição grande demais.'));

    // Se a plataforma já consumiu o corpo (helpers), usa o valor dela, ainda respeitando o limite.
    if (req.readableEnded && req.body !== undefined) {
      const raw = Buffer.isBuffer(req.body) ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      return raw.length > max ? reject(new HttpError(413, 'Corpo da requisição grande demais.')) : resolve(raw);
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.destroy(); return reject(new HttpError(413, 'Corpo da requisição grande demais.')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, 'Falha ao ler a requisição.')));
  });
}

/** Lê o corpo como JSON (objeto simples). */
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) throw new HttpError(400, 'Corpo da requisição vazio ou grande demais.');
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON inválido.'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'JSON inválido.');
  return data;
}

/** Lê um formulário application/x-www-form-urlencoded (limite pequeno: só o login usa). */
async function readForm(req, limit) {
  const raw = await readBody(req, limit || 10000);
  const out = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) out[k] = v;
  return out;
}

/** Cookies da requisição como objeto. */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** IP do visitante. Na Vercel, x-real-ip / x-forwarded-for são definidos pela própria plataforma. */
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

/** A conexão chegou por HTTPS? (decide a flag Secure do cookie). */
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** Query string da requisição como objeto (funciona com ou sem os helpers da Vercel). */
function queryOf(req) {
  const u = new URL(req.url, 'http://localhost');
  const out = {};
  for (const [k, v] of u.searchParams) out[k] = v;
  return out;
}

module.exports = { HttpError, json, html, readBody, readJson, readForm, parseCookies, clientIp, isHttps, queryOf, applyHeaders };
