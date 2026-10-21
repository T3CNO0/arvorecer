/* =============================================================================
   ARVORECER — servidor local de desenvolvimento (npm run dev)
   Imita a Vercel: serve public/, roda api/*.js e aplica a reescrita /admin.
   Sem DATABASE_URL, usa um Postgres local em WebAssembly (gravado em .devdata/).
   Uso:  ADMIN_PASSWORD=... SESSION_SECRET=... node tools/dev-server.js
   ============================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const db = require('../lib/db');
const cfg = require('../lib/config');

const VERCEL = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

(async () => {
  if (!cfg.databaseUrl()) {
    db.setAdapter(await require('./pglite-adapter')(path.join(root, '.devdata')));
    console.log('[dev] sem DATABASE_URL: usando Postgres local (PGlite) em .devdata/');
  }
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (p === '/admin' || p === '/admin.php') p = '/api/admin';
    const m = p.match(/^\/api\/([a-z_]+)$/);
    if (m && fs.existsSync(path.join(root, 'api', m[1] + '.js'))) {
      return Promise.resolve(require('../api/' + m[1] + '.js')(req, res)).catch((e) => { console.error(e); res.statusCode = 500; res.end('erro'); });
    }
    const file = path.join(root, 'public', p === '/' || p === '/index.html' ? 'index.html' : p);
    if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('404'); }
    // aplica os cabeçalhos do vercel.json (CSP etc.) para testar localmente o mesmo comportamento
    for (const rule of VERCEL.headers || []) {
      if (rule.source === '/(.*)' || rule.source === p || (rule.source === '/' && p === '/index.html')) {
        for (const h of rule.headers) res.setHeader(h.key, h.value);
      }
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`[dev] http://localhost:${port}  (painel: /admin)`));
})();
