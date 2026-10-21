/* Adaptador de banco para TESTE/DESENVOLVIMENTO: Postgres em WebAssembly (PGlite), sem instalar nada.
   Nunca é usado em produção (lá vale o DATABASE_URL). */
'use strict';
module.exports = async function createPgliteAdapter(dataDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    query: (t, p) => pg.query(t, p),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })),
    close: () => pg.close(),
  };
};
