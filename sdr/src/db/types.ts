/**
 * Contrato da camada de persistência. Ver server/src/db/types.ts (mesmo
 * desenho, reaproveitado aqui): a aplicação nunca fala com o driver
 * diretamente, então os testes de regra de negócio rodam em memória.
 *
 * Convenções obrigatórias em todo o projeto:
 *   - Placeholders sempre `?`.
 *   - Timestamps sempre TEXT em ISO-8601 UTC.
 *   - Booleanos sempre INTEGER 0/1.
 */

export type SqlParam = string | number | null;

export interface Db {
  readonly dialect: 'sqlite';
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class UniqueViolation extends Error {
  readonly constraint: string;
  constructor(constraint: string) {
    super(`Violação de unicidade: ${constraint}`);
    this.name = 'UniqueViolation';
    this.constraint = constraint;
  }
}
