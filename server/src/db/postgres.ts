/**
 * Adaptador PostgreSQL.
 *
 * ATENÇÃO — LEIA ANTES DE USAR EM PRODUÇÃO
 * ----------------------------------------
 * Este é o único módulo do projeto que depende de um pacote npm (`pg`) e,
 * por isso, o único que NÃO foi executado na bancada onde o resto do sistema
 * foi testado (o ambiente de desenvolvimento não tinha acesso ao registro npm
 * nem a um servidor PostgreSQL). Todo o restante do código — autenticação,
 * isolamento entre consultores, ETL, cálculos — roda e é testado sobre SQLite.
 *
 * Antes do primeiro deploy em Postgres, execute a suíte apontando para um
 * banco real. O comando existe e está documentado no README:
 *
 *     DATABASE_URL=postgres://... npm run test:db
 *
 * A suíte é a mesma; ela apenas troca o adaptador. Se passar, este arquivo
 * está correto. Se falhar, o erro estará aqui e não na regra de negócio.
 *
 * O acoplamento com `pg` é deliberadamente mínimo: conversão de placeholders,
 * pool e tradução de erro. Nada mais.
 */

import type { Db, SqlParam } from './types.ts';
import { UniqueViolation } from './types.ts';

/**
 * Converte `?` para `$1..$n`, respeitando literais entre aspas simples e
 * identificadores entre aspas duplas — um `?` dentro de string não é
 * placeholder. Também preserva o operador `??` de jsonb, se houver.
 */
export function toDollarPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = sql[i + 1] === "'" ? (out += sql[++i]!, true) : false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === '?') {
      if (sql[i + 1] === '?') { out += '??'; i++; continue; } // operador jsonb
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release?(): void;
}
interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

function translate(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code === '23505') throw new UniqueViolation(e.constraint ?? 'desconhecida');
  throw err;
}

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  readonly runner: PgPoolLike | PgClientLike;
  readonly pool: PgPoolLike | null;

  constructor(runner: PgPoolLike | PgClientLike, pool: PgPoolLike | null) {
    this.runner = runner;
    this.pool = pool;
  }

  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    try {
      const r = await this.runner.query(toDollarPlaceholders(sql), params);
      return r.rows as T[];
    } catch (e) { translate(e); }
  }

  async get<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    try {
      const r = await this.runner.query(toDollarPlaceholders(sql), params);
      return { changes: r.rowCount ?? 0 };
    } catch (e) { translate(e); }
  }

  async exec(sql: string): Promise<void> {
    try { await this.runner.query(sql); } catch (e) { translate(e); }
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this); // já é um client dentro de transação
    const client = await this.pool.connect();
    const scoped = new PostgresDb(client, null);
    try {
      await client.query('BEGIN');
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* conexão já perdida */ }
      throw e;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

export async function openPostgres(url: string): Promise<Db> {
  let pg: { Pool: new (cfg: Record<string, unknown>) => PgPoolLike };
  try {
    // Especificador em variável de propósito: `pg` é dependência opcional, e
    // um import literal faria o typecheck falhar em toda instalação SQLite,
    // que é a maioria. A tipagem vem das interfaces PgPoolLike/PgClientLike
    // declaradas acima, que descrevem exatamente o que usamos.
    const especificador = 'pg';
    pg = (await import(especificador)) as unknown as { Pool: new (cfg: Record<string, unknown>) => PgPoolLike };
  } catch {
    throw new Error(
      'DATABASE_URL aponta para PostgreSQL, mas o pacote "pg" não está instalado.\n' +
      'Rode `npm install pg` no diretório server/, ou use uma DATABASE_URL sqlite:.',
    );
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Em produção, exija TLS. Defina PGSSLMODE=disable apenas em rede interna.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  return new PostgresDb(pool, pool);
}
