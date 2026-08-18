/**
 * Fábrica de conexão. O tipo de banco é escolhido pela DATABASE_URL:
 *
 *   sqlite:./data/app.db        arquivo local
 *   sqlite::memory:             em memória (testes)
 *   postgres://user:pw@host/db  PostgreSQL
 */

import type { Db } from './types.ts';
import { openSqlite } from './sqlite.ts';
import { openPostgres } from './postgres.ts';

export type { Db } from './types.ts';
export { UniqueViolation } from './types.ts';
export { migrate } from './migrations.ts';

export async function connect(databaseUrl: string): Promise<Db> {
  if (databaseUrl.startsWith('sqlite:')) {
    return openSqlite(databaseUrl.slice('sqlite:'.length) || ':memory:');
  }
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return openPostgres(databaseUrl);
  }
  throw new Error(
    `DATABASE_URL inválida: "${databaseUrl}". ` +
    'Use sqlite:./data/app.db, sqlite::memory: ou postgres://...',
  );
}
