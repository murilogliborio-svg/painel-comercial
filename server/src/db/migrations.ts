/**
 * Migrations versionadas, aplicadas em ordem e registradas em schema_migrations.
 *
 * Cada migration declara o DDL das duas dialetos explicitamente. Tradução
 * automática de DDL entre bancos é uma fonte clássica de divergência sutil
 * (tipos de data, autoincremento, JSON); escrever as duas versões é mais
 * verboso e infinitamente mais confiável.
 *
 * Regras do schema:
 *   - Ids são TEXT (ULID gerado na aplicação): portável e ordenável por tempo.
 *   - Timestamps são TEXT ISO-8601 UTC.
 *   - Booleanos são INTEGER/SMALLINT 0|1.
 *   - Dinheiro é INTEGER em CENTAVOS. Ver domain/dinheiro.ts.
 */

import type { Db } from './types.ts';

export interface Migration {
  id: string;
  sqlite: string;
  postgres: string;
}

/** Tipos que diferem entre os bancos, para reduzir duplicação no DDL. */
const T = {
  sqlite: { pk: 'TEXT PRIMARY KEY', ts: 'TEXT', bool: 'INTEGER', money: 'INTEGER', num: 'REAL', json: 'TEXT' },
  postgres: { pk: 'TEXT PRIMARY KEY', ts: 'TEXT', bool: 'SMALLINT', money: 'BIGINT', num: 'DOUBLE PRECISION', json: 'TEXT' },
} as const;

function ddl(d: 'sqlite' | 'postgres'): string {
  const t = T[d];
  return `
CREATE TABLE consultores (
  id            ${t.pk},
  nome          TEXT NOT NULL UNIQUE,
  ativo         ${t.bool} NOT NULL DEFAULT 1,
  criado_em     ${t.ts} NOT NULL
);

CREATE TABLE users (
  id             ${t.pk},
  email          TEXT NOT NULL UNIQUE,
  nome           TEXT NOT NULL,
  papel          TEXT NOT NULL CHECK (papel IN ('admin','gestor','consultor')),
  consultor_id   TEXT NULL REFERENCES consultores(id),
  senha_hash     TEXT NOT NULL,
  trocar_senha   ${t.bool} NOT NULL DEFAULT 1,
  pode_escrever  ${t.bool} NOT NULL DEFAULT 1,
  ativo          ${t.bool} NOT NULL DEFAULT 1,
  falhas         INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate  ${t.ts} NULL,
  ultimo_login   ${t.ts} NULL,
  senha_alterada_em ${t.ts} NULL,
  criado_em      ${t.ts} NOT NULL,
  atualizado_em  ${t.ts} NOT NULL
);
CREATE INDEX idx_users_consultor ON users(consultor_id);

CREATE TABLE sessoes (
  id           ${t.pk},
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  criado_em    ${t.ts} NOT NULL,
  expira_em    ${t.ts} NOT NULL,
  ultimo_uso   ${t.ts} NOT NULL,
  revogado_em  ${t.ts} NULL,
  ip           TEXT NULL,
  user_agent   TEXT NULL
);
CREATE INDEX idx_sessoes_user ON sessoes(user_id);
CREATE INDEX idx_sessoes_expira ON sessoes(expira_em);

CREATE TABLE auditoria (
  id           ${t.pk},
  criado_em    ${t.ts} NOT NULL,
  user_id      TEXT NULL,
  email        TEXT NULL,
  acao         TEXT NOT NULL,
  entidade     TEXT NULL,
  entidade_id  TEXT NULL,
  sucesso      ${t.bool} NOT NULL DEFAULT 1,
  ip           TEXT NULL,
  user_agent   TEXT NULL,
  detalhe      ${t.json} NULL
);
CREATE INDEX idx_auditoria_criado ON auditoria(criado_em);
CREATE INDEX idx_auditoria_user ON auditoria(user_id);
CREATE INDEX idx_auditoria_acao ON auditoria(acao);

CREATE TABLE importacoes (
  id            ${t.pk},
  criado_por    TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('rascunho','confirmada','revertida')),
  periodo_ini   ${t.ts} NULL,
  periodo_fim   ${t.ts} NULL,
  arquivos      ${t.json} NOT NULL,
  estatisticas  ${t.json} NOT NULL,
  observacao    TEXT NULL,
  criado_em     ${t.ts} NOT NULL,
  confirmado_em ${t.ts} NULL,
  revertido_em  ${t.ts} NULL
);
CREATE INDEX idx_importacoes_status ON importacoes(status);

CREATE TABLE configuracoes (
  chave      TEXT PRIMARY KEY,
  valor      TEXT NOT NULL,
  atualizado_em ${t.ts} NOT NULL
);

CREATE TABLE oportunidades (
  id                ${t.pk},
  import_id         TEXT NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  num               TEXT NOT NULL,
  descricao         TEXT NULL,
  contato           TEXT NULL,
  tipo_evento       TEXT NULL,
  origem            TEXT NULL,
  data_evento       ${t.ts} NULL,
  pax               INTEGER NULL,
  status            TEXT NULL,
  data_oportunidade ${t.ts} NULL,
  proxima_acao      ${t.ts} NULL,
  ultima_acao       ${t.ts} NULL,
  ult_acao          TEXT NULL,
  UNIQUE (import_id, num)
);
CREATE INDEX idx_opp_import ON oportunidades(import_id);

CREATE TABLE acoes (
  id                  ${t.pk},
  import_id           TEXT NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  num_oportunidade    TEXT NOT NULL,
  acao                TEXT NOT NULL,
  status_acao         TEXT NOT NULL,
  num_cliente         TEXT NULL,
  nome_cliente        TEXT NULL,
  data_evento         ${t.ts} NULL,
  tipo_evento         TEXT NULL,
  data_oportunidade   ${t.ts} NULL,
  origem              TEXT NULL,
  status_oportunidade TEXT NULL,
  consultor_id        TEXT NULL REFERENCES consultores(id),
  dt_agendado         ${t.ts} NULL,
  presencial          ${t.bool} NOT NULL DEFAULT 0,
  linha               INTEGER NOT NULL
);
CREATE INDEX idx_acoes_import ON acoes(import_id);
CREATE INDEX idx_acoes_consultor ON acoes(import_id, consultor_id);
CREATE INDEX idx_acoes_opp ON acoes(import_id, num_oportunidade);

CREATE TABLE degustacoes (
  id               ${t.pk},
  import_id        TEXT NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  codigo           TEXT NULL,
  num_oportunidade TEXT NULL,
  descricao        TEXT NULL,
  qtd_pessoas      INTEGER NULL,
  data_chegada     ${t.ts} NULL,
  casa_chegada     TEXT NULL,
  consultor_id     TEXT NULL REFERENCES consultores(id),
  casas_vista      TEXT NULL,
  casa_degustacao  TEXT NULL,
  horario          ${t.ts} NULL,
  status           TEXT NULL
);
CREATE INDEX idx_deg_import ON degustacoes(import_id);
CREATE INDEX idx_deg_consultor ON degustacoes(import_id, consultor_id);

CREATE TABLE contratos (
  id               ${t.pk},
  import_id        TEXT NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  num_contrato     TEXT NOT NULL,
  id_evento        TEXT NULL,
  descricao        TEXT NULL,
  contratante      TEXT NULL,
  casa             TEXT NULL,
  tipo_evento      TEXT NULL,
  data_evento      ${t.ts} NULL,
  pax              INTEGER NULL,
  valor_minimo_c   ${t.money} NOT NULL DEFAULT 0,
  valor_original_c ${t.money} NOT NULL DEFAULT 0,
  valor_ajustado_c ${t.money} NOT NULL DEFAULT 0,
  status           TEXT NULL,
  fechamento       TEXT NULL,
  partes           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (import_id, num_contrato)
);
CREATE INDEX idx_contratos_import ON contratos(import_id);

CREATE TABLE contrato_creditos (
  id           ${t.pk},
  import_id    TEXT NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  contrato_id  TEXT NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  consultor_id TEXT NULL REFERENCES consultores(id),
  quantidade   ${t.num} NOT NULL,
  valor_c      ${t.money} NOT NULL
);
CREATE INDEX idx_creditos_import ON contrato_creditos(import_id, consultor_id);
CREATE INDEX idx_creditos_contrato ON contrato_creditos(contrato_id);

-- ---------------------------------------------------------------------------
-- Trabalho do consultor. NÃO pertence a nenhuma importação: sobrevive a todas
-- elas, referenciando a oportunidade pelo número, que é estável no CRM.
-- ---------------------------------------------------------------------------

CREATE TABLE tratativas (
  id               ${t.pk},
  num_oportunidade TEXT NOT NULL,
  chave_acao       TEXT NOT NULL,
  consultor_id     TEXT NOT NULL REFERENCES consultores(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  resultado        TEXT NOT NULL,
  observacao       TEXT NULL,
  tratado_em       ${t.ts} NOT NULL,
  UNIQUE (num_oportunidade, chave_acao, consultor_id)
);
CREATE INDEX idx_tratativas_consultor ON tratativas(consultor_id);

CREATE TABLE notas (
  id               ${t.pk},
  num_oportunidade TEXT NOT NULL,
  consultor_id     TEXT NOT NULL REFERENCES consultores(id),
  autor_id         TEXT NOT NULL REFERENCES users(id),
  texto            TEXT NOT NULL,
  criado_em        ${t.ts} NOT NULL,
  editado_em       ${t.ts} NULL,
  removido_em      ${t.ts} NULL
);
CREATE INDEX idx_notas_opp ON notas(num_oportunidade);
CREATE INDEX idx_notas_consultor ON notas(consultor_id);

CREATE TABLE metas (
  id           ${t.pk},
  consultor_id TEXT NOT NULL REFERENCES consultores(id),
  periodo_ini  ${t.ts} NOT NULL,
  periodo_fim  ${t.ts} NOT NULL,
  metrica      TEXT NOT NULL CHECK (metrica IN ('faturamento','contratos','degustacoes','conversao','acoes')),
  alvo         ${t.num} NOT NULL,
  observacao   TEXT NULL,
  criado_por   TEXT NOT NULL REFERENCES users(id),
  criado_em    ${t.ts} NOT NULL,
  UNIQUE (consultor_id, periodo_ini, periodo_fim, metrica)
);
CREATE INDEX idx_metas_consultor ON metas(consultor_id);
`;
}

export const MIGRATIONS: Migration[] = [
  { id: '0001_schema_inicial', sqlite: ddl('sqlite'), postgres: ddl('postgres') },
];

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       aplicada_em TEXT NOT NULL
     )`,
  );

  const done = new Set(
    (await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id),
  );

  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const sql = db.dialect === 'sqlite' ? m.sqlite : m.postgres;
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.run('INSERT INTO schema_migrations (id, aplicada_em) VALUES (?, ?)', [
        m.id,
        new Date().toISOString(),
      ]);
    });
    applied.push(m.id);
    log(`migration aplicada: ${m.id}`);
  }
  return applied;
}
