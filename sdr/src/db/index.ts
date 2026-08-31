/**
 * Fábrica de conexão.
 *
 *   sqlite:./data/app.db        arquivo local
 *   sqlite::memory:             em memória (testes)
 *
 * Só SQLite por enquanto: o volume deste serviço (equipe comercial de uma
 * empresa) não justifica Postgres. Se um dia justificar, seguir o mesmo
 * padrão do painel-comercial (server/src/db/postgres.ts) é a forma limpa
 * de adicionar — a interface Db já é o contrato que torna essa troca segura.
 */

import type { Db } from './types.ts';
import { openSqlite } from './sqlite.ts';

export type { Db } from './types.ts';
export { UniqueViolation } from './types.ts';
export { migrate } from './migrations.ts';

export async function connect(databaseUrl: string): Promise<Db> {
  if (databaseUrl.startsWith('sqlite:')) {
    return openSqlite(databaseUrl.slice('sqlite:'.length) || ':memory:');
  }
  throw new Error(
    `DATABASE_URL inválida: "${databaseUrl}". Use sqlite:./data/app.db ou sqlite::memory:.`,
  );
}
