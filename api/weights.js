/* =============================================================================
   ARVORECER — /api/weights
   Publica a TABELA ÚNICA de competências (N0 a N4) com o peso de cada uma, como
   definido em lib/config.js, para a página exibir os mesmos valores que o servidor
   usa no cálculo. (Pesos não são segredo; o GABARITO fica só no servidor.)
   A tabela é entregue MESCLADA; quem diferencia os testes é só o cálculo
   (Fundamental = N0; Interpretação = N1 a N4).
   ============================================================================= */
'use strict';
const cfg = require('../lib/config');
const { competencyWeight } = require('../lib/scoring');
const { json } = require('../lib/http');

module.exports = (req, res) => {
  const levels = Object.entries(cfg.LEVELS).map(([code, lv]) => ({
    code, name: lv.name, desc: lv.desc, weight: Number(lv.weight),
  }));
  const competencies = Object.entries(cfg.COMPETENCIES).map(([code, c]) => ({
    code,
    level: c.level,
    title: c.title,
    desc: c.desc,
    weight: competencyWeight(code),
    applied: !!c.applied,
    test: c.level === 'N0' ? 'fundamental' : 'interpretacao',   // qual teste usa esta competência
  }));
  json(res, 200, { ok: true, levels, competencies }, { 'Cache-Control': 'public, max-age=300' });
};
