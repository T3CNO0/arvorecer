/* =============================================================================
   ARVORECER — /api/respondentes
   Devolve apenas a QUANTIDADE de testes já registrados (número público exibido na
   página inicial). Não expõe nenhum dado individual.
   ============================================================================= */
'use strict';
const db = require('../lib/db');
const { json } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    const r = await db.query('SELECT COUNT(*)::int AS n FROM submissions');
    json(res, 200, { ok: true, responseCount: r.rows[0].n });
  } catch (e) {
    console.error('[arvorecer]', e.message);
    json(res, 500, { ok: false, error: 'Contagem indisponível.' });
  }
};
