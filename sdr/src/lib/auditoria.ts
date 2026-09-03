/**
 * Trilha de auditoria. Mesmo desenho do painel-comercial: este serviço
 * envia mensagens reais a clientes em nome da empresa, então "quem mandou o
 * quê, quando, e se foi a I.A. ou uma pessoa" precisa ficar registrado —
 * LGPD art. 37 e também governança básica de uma automação com autonomia
 * de envio.
 */

import type { Db } from '../db/index.ts';
import { ulid } from './ids.ts';

export type AcaoAuditavel =
  | 'login.sucesso' | 'login.falha' | 'login.bloqueado' | 'logout'
  | 'senha.alterada' | 'senha.redefinida'
  | 'usuario.criado' | 'usuario.alterado'
  | 'lead.criado' | 'lead.alterado' | 'lead.pausado' | 'lead.retomado'
  | 'lead.excluido' | 'leads.importados'
  | 'lead.opt_out'
  | 'mensagem.gerada' | 'mensagem.enviada' | 'mensagem.falhou' | 'mensagem.recebida'
  | 'mensagem.bloqueada_por_regra'
  | 'config.alterada'
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

export async function expurgarAuditoria(db: Db, dias: number, agora = new Date()): Promise<number> {
  const corte = new Date(agora.getTime() - dias * 86_400_000).toISOString();
  const r = await db.run('DELETE FROM auditoria WHERE criado_em < ?', [corte]);
  return r.changes;
}
