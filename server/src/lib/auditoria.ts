/**
 * Trilha de auditoria.
 *
 * Registra quem fez o quê, quando e de onde. Existe por três motivos, nesta
 * ordem de importância:
 *
 *   1. LGPD, art. 37: o controlador deve manter registro das operações de
 *      tratamento de dados pessoais. Aqui há nome e contato de clientes.
 *   2. Investigação: saber quem exportou ou consultou o quê depois de um
 *      incidente, ou quando um colaborador sai da empresa.
 *   3. Gestão: quem importou qual planilha e quando.
 *
 * A gravação nunca derruba a operação principal — auditoria que quebra o
 * sistema vira auditoria desligada. Falhas são registradas no log do processo.
 */

import type { Db } from '../db/index.ts';
import { ulid } from './ids.ts';

export type AcaoAuditavel =
  | 'login.sucesso' | 'login.falha' | 'login.bloqueado' | 'logout'
  | 'senha.alterada' | 'senha.redefinida'
  | 'sessao.expirada' | 'sessao.revogada'
  | 'usuario.criado' | 'usuario.alterado' | 'usuario.desativado'
  | 'importacao.enviada' | 'importacao.confirmada' | 'importacao.revertida' | 'importacao.descartada'
  | 'painel.consultado' | 'lista.consultada' | 'exportacao.gerada'
  | 'tratativa.registrada' | 'nota.criada' | 'nota.removida'
  | 'meta.definida' | 'meta.removida'
  | 'acesso.negado';

export interface EntradaAuditoria {
  acao: AcaoAuditavel;
  userId?: string | null;
  email?: string | null;
  entidade?: string | null;
  entidadeId?: string | null;
  sucesso?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  detalhe?: Record<string, unknown> | null;
}

export function criarAuditor(db: Db, aoFalhar: (e: unknown) => void = () => {}) {
  return async function registrar(e: EntradaAuditoria): Promise<void> {
    try {
      await db.run(
        `INSERT INTO auditoria
           (id, criado_em, user_id, email, acao, entidade, entidade_id, sucesso, ip, user_agent, detalhe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ulid(),
          new Date().toISOString(),
          e.userId ?? null,
          e.email ?? null,
          e.acao,
          e.entidade ?? null,
          e.entidadeId ?? null,
          e.sucesso === false ? 0 : 1,
          e.ip ?? null,
          e.userAgent?.slice(0, 300) ?? null,
          e.detalhe ? JSON.stringify(e.detalhe) : null,
        ],
      );
    } catch (err) {
      aoFalhar(err);
    }
  };
}

export type Auditor = ReturnType<typeof criarAuditor>;

/**
 * Expurga registros além do prazo de retenção (LGPD, princípio da
 * necessidade: não guardar dado pessoal por mais tempo que o necessário).
 */
export async function expurgarAuditoria(db: Db, dias: number, agora = new Date()): Promise<number> {
  const corte = new Date(agora.getTime() - dias * 86_400_000).toISOString();
  const r = await db.run('DELETE FROM auditoria WHERE criado_em < ?', [corte]);
  return r.changes;
}
