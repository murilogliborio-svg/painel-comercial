/**
 * Identidade e autorização.
 *
 * A REGRA CENTRAL DO SISTEMA
 * --------------------------
 * Um consultor enxerga exclusivamente os próprios dados. Isso NÃO é aplicado
 * no frontend nem por filtro opcional: é aplicado no SQL, por meio de
 * `escopoConsultor()`, que devolve o `consultor_id` obrigatório para quem tem
 * papel de consultor e `null` (sem restrição) para gestor e admin.
 *
 * Toda consulta que toca dado de cliente recebe esse escopo. O teste
 * `test/isolamento.test.ts` prova que um consultor autenticado não consegue
 * ler dado de outro nem informando o id de outro na URL.
 */

import type { Db } from '../db/index.ts';
import type { Requisicao } from '../http/servidor.ts';
import { erro } from '../http/servidor.ts';

export type Papel = 'admin' | 'gestor' | 'consultor';

export interface Usuario {
  id: string;
  email: string;
  nome: string;
  papel: Papel;
  consultor_id: string | null;
  pode_escrever: number;
  trocar_senha: number;
  ativo: number;
}

export interface Autenticado {
  usuario: Usuario;
  sessaoId: string;
}

/** Recupera o usuário autenticado da requisição ou lança 401. */
export function exigirAuth(req: Requisicao): Autenticado {
  const a = req.ctx['auth'] as Autenticado | undefined;
  if (!a) throw erro.naoAutenticado();
  return a;
}

/** Exige um dos papéis informados. */
export function exigirPapel(req: Requisicao, ...papeis: Papel[]): Autenticado {
  const a = exigirAuth(req);
  if (!papeis.includes(a.usuario.papel)) {
    throw erro.proibido(
      `Esta operação exige perfil de ${papeis.join(' ou ')}. Seu perfil é ${a.usuario.papel}.`,
    );
  }
  return a;
}

/** Exige permissão de escrita (o gestor pode marcar um usuário como leitor). */
export function exigirEscrita(req: Requisicao): Autenticado {
  const a = exigirAuth(req);
  if (!a.usuario.pode_escrever) {
    throw erro.proibido('Seu acesso é somente leitura. Fale com o gestor para liberar edição.');
  }
  return a;
}

/**
 * Escopo obrigatório de consultor para as consultas.
 *
 *   - papel 'consultor'  -> o próprio consultor_id (nunca outro)
 *   - papel 'gestor'/'admin' -> null (vê todos) ou o filtro pedido na query
 *
 * Um consultor que passe `?consultor=<outro>` recebe 403, e não uma lista
 * vazia: falhar em voz alta é melhor do que parecer que o dado não existe.
 */
export function escopoConsultor(req: Requisicao, pedido?: string | null): string | null {
  const { usuario } = exigirAuth(req);

  if (usuario.papel === 'consultor') {
    if (!usuario.consultor_id) {
      throw erro.proibido(
        'Sua conta não está vinculada a nenhum consultor. Peça ao gestor para configurar o vínculo.',
      );
    }
    if (pedido && pedido !== usuario.consultor_id) {
      throw erro.proibido('Você só pode consultar os seus próprios dados.');
    }
    return usuario.consultor_id;
  }

  return pedido && pedido.trim() !== '' ? pedido : null;
}

/** Carrega o usuário pelo id, já filtrando inativos. */
export async function carregarUsuario(db: Db, id: string): Promise<Usuario | null> {
  return db.get<Usuario>(
    `SELECT id, email, nome, papel, consultor_id, pode_escrever, trocar_senha, ativo
       FROM users WHERE id = ? AND ativo = 1`,
    [id],
  );
}
