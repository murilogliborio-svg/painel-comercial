/**
 * Adaptador SQLite sobre `node:sqlite` (embutido no Node 22+).
 *
 * Este serviço é operado por um time comercial pequeno (dezenas de pessoas),
 * então uma instância única em SQLite é suficiente — mesma decisão e mesmas
 * ressalvas do painel-comercial (ver OPERACAO.md lá). Backup é copiar o
 * arquivo do banco.
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
    if (this.#inTx) return fn(this);
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

  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  return new SqliteDb(raw);
}
