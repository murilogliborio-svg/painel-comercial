/**
 * Contrato da camada de persistência.
 *
 * A aplicação nunca fala com um driver diretamente: fala com esta interface.
 * Isso permite rodar sobre SQLite (desenvolvimento, instalações pequenas) ou
 * PostgreSQL (produção) sem tocar em nenhuma linha de regra de negócio, e
 * torna os testes de segurança executáveis em memória.
 *
 * Convenções obrigatórias em todo o projeto:
 *   - Placeholders sempre `?`. O adaptador Postgres converte para `$1..$n`.
 *   - Timestamps sempre TEXT em ISO-8601 UTC (`2026-08-17T12:00:00.000Z`).
 *     Ordenação lexicográfica equivale à cronológica e não há drift de fuso.
 *   - Booleanos sempre INTEGER 0/1.
 *   - Dinheiro sempre INTEGER em centavos. Nunca ponto flutuante.
 */

export type SqlParam = string | number | null;

export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  readonly dialect: Dialect;

  /** Retorna todas as linhas. */
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;

  /** Retorna a primeira linha ou null. */
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;

  /** Executa comando sem retorno de linhas. */
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;

  /** Executa SQL bruto (migrations). Não aceita parâmetros. */
  exec(sql: string): Promise<void>;

  /**
   * Executa `fn` dentro de uma transação. Faz commit no retorno e rollback em
   * qualquer exceção. Transações aninhadas reutilizam a externa (savepoints
   * não são necessários no uso atual e seriam uma fonte silenciosa de erro).
   */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** Erro de integridade traduzido pelos adaptadores para um tipo comum. */
export class UniqueViolation extends Error {
  readonly constraint: string;

  constructor(constraint: string) {
    super(`Violação de unicidade: ${constraint}`);
    this.name = 'UniqueViolation';
    this.constraint = constraint;
  }
}
