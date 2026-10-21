/* =============================================================================
   ARVORECER — ACESSO AO BANCO (Postgres)  (lib/db.js)
   -----------------------------------------------------------------------------
   Duas funções para o resto do código:
     query(texto, parametros)        -> { rows: [...] }
     transaction(async (tx) => ...)  -> tudo-ou-nada; dentro dela use tx.query(...)

   O banco é um Postgres externo (Neon, Supabase, Vercel Postgres…), apontado pela
   variável de ambiente DATABASE_URL (ou POSTGRES_URL). Em funções serverless o disco
   não persiste, por isso NÃO usamos SQLite aqui.

   Para testes automáticos, setAdapter() troca o Postgres real por outro adaptador
   com a mesma interface (tests/ usa um Postgres em WebAssembly).

   Todas as consultas usam parâmetros ($1, $2…): nunca montamos SQL com texto do usuário.
   ============================================================================= */
'use strict';

const cfg = require('./config');
const { STATEMENTS } = require('./schema');

let adapter = null;     // adaptador ativo (criado sob demanda)
let ready = null;       // promessa da criação das tabelas (uma vez por instância)

/** Adaptador de produção: node-postgres (pg) com um pequeno pool. */
function createPgAdapter(connectionString) {
  const { Pool } = require('pg');
  // max baixo: cada instância serverless usa poucas conexões; use a URL "pooled" do provedor.
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error('[arvorecer] erro no pool do banco:', e.message));
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, p) => client.query(t, p) });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** Troca o adaptador (usado só pelos testes). */
function setAdapter(a) { adapter = a; ready = null; }

function getAdapter() {
  if (adapter) return adapter;
  const url = cfg.databaseUrl();
  if (!url) {
    throw new Error('Banco não configurado: defina DATABASE_URL (ou POSTGRES_URL) nas variáveis de ambiente da Vercel.');
  }
  adapter = createPgAdapter(url);
  return adapter;
}

/** Cria as tabelas se ainda não existirem (uma vez por instância; tenta de novo se falhar). */
async function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const a = getAdapter();
      for (const sql of STATEMENTS) {
        try {
          await a.query(sql);
        } catch (e) {
          // duas instâncias criando ao mesmo tempo podem colidir: tenta uma vez mais
          await a.query(sql);
        }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function query(text, params) {
  await ensureSchema();
  return getAdapter().query(text, params);
}

async function transaction(fn) {
  await ensureSchema();
  return getAdapter().transaction(fn);
}

module.exports = { query, transaction, setAdapter, ensureSchema };
