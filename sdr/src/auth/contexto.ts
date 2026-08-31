/**
 * Identidade e autorização.
 *
 * Dois papéis, mais simples que o painel-comercial porque aqui não há
 * carteira exclusiva por pessoa — a fila de leads é do time inteiro:
 *
 *   - 'comercial': vê e trabalha todos os leads, pode pausar/retomar a
 *      automação de um lead, gera e edita mensagens, mas NÃO mexe em
 *      persona/regras de envio nem em usuários.
 *   - 'admin': tudo acima + configura a persona da I.A., as regras de envio
 *      autônomo, cria/desativa usuários e lê a auditoria.
 */

import type { Db } from '../db/index.ts';
import type { Requisicao } from '../http/servidor.ts';
import { erro } from '../http/servidor.ts';

export type Papel = 'admin' | 'comercial';

export interface Usuario {
  id: string;
  email: string;
  nome: string;
  papel: Papel;
  trocar_senha: number;
  ativo: number;
}

export interface Autenticado {
  usuario: Usuario;
  sessaoId: string;
}

export function exigirAuth(req: Requisicao): Autenticado {
  const a = req.ctx['auth'] as Autenticado | undefined;
  if (!a) throw erro.naoAutenticado();
  return a;
}

export function exigirPapel(req: Requisicao, ...papeis: Papel[]): Autenticado {
  const a = exigirAuth(req);
  if (!papeis.includes(a.usuario.papel)) {
    throw erro.proibido(
      `Esta operação exige perfil de ${papeis.join(' ou ')}. Seu perfil é ${a.usuario.papel}.`,
    );
  }
  return a;
}

export async function carregarUsuario(db: Db, id: string): Promise<Usuario | null> {
  return db.get<Usuario>(
    `SELECT id, email, nome, papel, trocar_senha, ativo FROM users WHERE id = ? AND ativo = 1`,
    [id],
  );
}
