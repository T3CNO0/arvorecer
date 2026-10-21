-- ARVORECER — tabelas do Postgres. As funções criam isto sozinhas na 1ª requisição;
-- rode à mão apenas se preferir (ex.: usuário do banco sem permissão de CREATE).
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL,                   -- sempre minúsculo
    name          TEXT NOT NULL,
    code          TEXT NOT NULL,                   -- código do professor (digitado no Teste Fundamental)
    role          TEXT NOT NULL DEFAULT 'teacher', -- owner | teacher
    password_hash TEXT,                            -- scrypt; vazio até a pessoa definir a senha pelo link
    pw_version    INTEGER NOT NULL DEFAULT 1,      -- sobe a cada troca de senha/desativação: derruba sessões antigas
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_code ON users(lower(code));

CREATE TABLE IF NOT EXISTS user_tokens (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    purpose    TEXT NOT NULL,                      -- invite | reset
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
  );

CREATE TABLE IF NOT EXISTS submissions (
    id               SERIAL PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    mode             TEXT NOT NULL,                -- autonomo (Interpretação N1–N4) | mediado (Fundamental N0)
    age_range        TEXT,
    education        TEXT,
    region           TEXT,
    arrival_source   TEXT,
    total            INTEGER NOT NULL,             -- nº de itens do teste
    correct          DOUBLE PRECISION NOT NULL,    -- acertos (fundamental: parcial vale 0,5)
    score_weighted   INTEGER NOT NULL,             -- score PONDERADO 0-100
    score_raw        INTEGER NOT NULL,             -- score BRUTO 0-100 (só acertos)
    duration_seconds INTEGER,
    student_code     TEXT,                         -- só teste fundamental (nome do aluno)
    teacher_code     TEXT,                         -- só teste fundamental (nome do professor)
    notes            TEXT,                         -- observações do professor
    ip_hash          TEXT,
    breakdown_json   JSONB                         -- resumo por competência
  );

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sub_teacher ON submissions(teacher_id);

CREATE TABLE IF NOT EXISTS answers (
    id            BIGSERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    question_id   TEXT NOT NULL,
    competency    TEXT NOT NULL,
    group_idx     INTEGER,
    answer        TEXT,
    points        DOUBLE PRECISION NOT NULL,       -- 0, 0.5 ou 1
    weight        DOUBLE PRECISION NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_answers_sub ON answers(submission_id);

CREATE INDEX IF NOT EXISTS idx_sub_created ON submissions(created_at);

CREATE INDEX IF NOT EXISTS idx_sub_ip ON submissions(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS admin_login_failures (
    id         BIGSERIAL PRIMARY KEY,
    ip_hash    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS idx_fail_ip ON admin_login_failures(ip_hash, created_at);
