/**
 * Migrations versionadas, aplicadas em ordem e registradas em schema_migrations.
 * Mesmo desenho do painel-comercial (server/src/db/migrations.ts).
 */

import type { Db } from './types.ts';

export interface Migration {
  id: string;
  sqlite: string;
}

const DDL = `
CREATE TABLE users (
  id                ${'TEXT PRIMARY KEY'},
  email             TEXT NOT NULL UNIQUE,
  nome              TEXT NOT NULL,
  papel             TEXT NOT NULL CHECK (papel IN ('admin','comercial')),
  senha_hash        TEXT NOT NULL,
  trocar_senha      INTEGER NOT NULL DEFAULT 1,
  ativo             INTEGER NOT NULL DEFAULT 1,
  falhas            INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate     TEXT NULL,
  ultimo_login      TEXT NULL,
  senha_alterada_em TEXT NULL,
  criado_em         TEXT NOT NULL,
  atualizado_em     TEXT NOT NULL
);

CREATE TABLE sessoes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  criado_em    TEXT NOT NULL,
  expira_em    TEXT NOT NULL,
  ultimo_uso   TEXT NOT NULL,
  revogado_em  TEXT NULL,
  ip           TEXT NULL,
  user_agent   TEXT NULL
);
CREATE INDEX idx_sessoes_user ON sessoes(user_id);
CREATE INDEX idx_sessoes_expira ON sessoes(expira_em);

CREATE TABLE auditoria (
  id           TEXT PRIMARY KEY,
  criado_em    TEXT NOT NULL,
  user_id      TEXT NULL,
  email        TEXT NULL,
  acao         TEXT NOT NULL,
  entidade     TEXT NULL,
  entidade_id  TEXT NULL,
  sucesso      INTEGER NOT NULL DEFAULT 1,
  ip           TEXT NULL,
  user_agent   TEXT NULL,
  detalhe      TEXT NULL
);
CREATE INDEX idx_auditoria_criado ON auditoria(criado_em);
CREATE INDEX idx_auditoria_user ON auditoria(user_id);
CREATE INDEX idx_auditoria_acao ON auditoria(acao);

-- Configuração-chave/valor: persona da I.A. e regras de envio autônomo.
-- Guardadas aqui (não em variável de ambiente) porque o gestor precisa
-- poder ajustá-las pela tela, sem redeploy.
CREATE TABLE config (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  atualizado_por TEXT NULL REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- Leads e conversas de aquecimento.
-- ---------------------------------------------------------------------------

CREATE TABLE leads (
  id                  TEXT PRIMARY KEY,
  nome                TEXT NOT NULL,
  telefone            TEXT NOT NULL,
  email               TEXT NULL,
  origem              TEXT NULL,
  contexto            TEXT NULL,
  estagio             TEXT NOT NULL DEFAULT 'novo'
                        CHECK (estagio IN (
                          'novo','aquecendo','aguardando_resposta','respondeu',
                          'quente','convertido','perdido','pausado'
                        )),
  responsavel_id      TEXT NULL REFERENCES users(id),
  opt_out             INTEGER NOT NULL DEFAULT 0,
  automacao_ativa     INTEGER NOT NULL DEFAULT 1,
  sequencia_passo     INTEGER NOT NULL DEFAULT 0,
  mensagens_sem_resposta INTEGER NOT NULL DEFAULT 0,
  proxima_mensagem_em TEXT NULL,
  ultima_mensagem_em  TEXT NULL,
  ultima_resposta_em  TEXT NULL,
  criado_por          TEXT NOT NULL REFERENCES users(id),
  criado_em           TEXT NOT NULL,
  atualizado_em       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_leads_telefone ON leads(telefone);
CREATE INDEX idx_leads_estagio ON leads(estagio);
CREATE INDEX idx_leads_proxima ON leads(proxima_mensagem_em);
CREATE INDEX idx_leads_responsavel ON leads(responsavel_id);

CREATE TABLE mensagens (
  id             TEXT PRIMARY KEY,
  lead_id        TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direcao        TEXT NOT NULL CHECK (direcao IN ('saida','entrada')),
  canal          TEXT NOT NULL DEFAULT 'whatsapp',
  texto          TEXT NOT NULL,
  gerada_por_ia  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('rascunho','enviada','simulada','falhou','recebida')),
  erro           TEXT NULL,
  mensagem_externa_id TEXT NULL,
  criado_por     TEXT NULL REFERENCES users(id),
  criado_em      TEXT NOT NULL,
  enviada_em     TEXT NULL
);
CREATE INDEX idx_mensagens_lead ON mensagens(lead_id, criado_em);
`;

export const MIGRATIONS: Migration[] = [
  { id: '0001_schema_inicial', sqlite: DDL },
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
    await db.tx(async (t) => {
      await t.exec(m.sqlite);
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
