/**
 * Adaptador SQLite sobre `node:sqlite` (embutido no Node 22+).
 *
 * Por que SQLite é uma escolha legítima aqui, e não um atalho:
 *   - O perfil de carga é dezenas de usuários com leitura predominante.
 *   - Em WAL, leituras concorrentes não bloqueiam e a escrita é serializada
 *     pelo próprio processo, que é single-threaded.
 *   - Backup é copiar um arquivo; restauração é copiar de volta.
 *
 * Quando migrar para PostgreSQL: mais de uma instância da aplicação, réplica
 * de leitura, ou necessidade de acesso concorrente por outra ferramenta.
 * A troca é feita apenas pela variável DATABASE_URL.
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Db, SqlParam } from './types.ts';
import { UniqueViolation } from './types.ts';

function translate(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed:\s*(.+)/i.test(msg)) {
    throw new UniqueViolation(/UNIQUE constraint failed:\s*(.+)/i.exec(msg)![1]!.trim());
  }
  throw err;
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  #inTx = false;
  readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    try {
      return this.raw.prepare(sql).all(...params) as T[];
    } catch (e) { translate(e); }
  }

  async get<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    try {
      return (this.raw.prepare(sql).get(...params) as T | undefined) ?? null;
    } catch (e) { translate(e); }
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    try {
      const r = this.raw.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    } catch (e) { translate(e); }
  }

  async exec(sql: string): Promise<void> {
    try { this.raw.exec(sql); } catch (e) { translate(e); }
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.#inTx) return fn(this); // já dentro de uma transação: participa dela
    this.raw.exec('BEGIN IMMEDIATE');
    this.#inTx = true;
    try {
      const out = await fn(this);
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* já desfeita */ }
      throw e;
    } finally {
      this.#inTx = false;
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

export function openSqlite(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);

  // WAL: leitores não bloqueiam o escritor. Irrelevante em :memory:.
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
  // FULL seria mais seguro contra queda de energia, NORMAL é o equilíbrio
  // recomendado quando há WAL. Em VM com disco de rede, considere FULL.
  raw.exec('PRAGMA synchronous = NORMAL');
  // Sem isso o SQLite ignora silenciosamente as foreign keys.
  raw.exec('PRAGMA foreign_keys = ON');
  // Falha rápido em vez de travar indefinidamente esperando o lock.
  raw.exec('PRAGMA busy_timeout = 5000');

  return new SqliteDb(raw);
}
