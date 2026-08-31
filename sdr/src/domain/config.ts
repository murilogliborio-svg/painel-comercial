/**
 * Persona e regras de envio ficam no banco (tabela `config`), não em
 * variável de ambiente: o gestor precisa poder ajustar tom, assinatura e
 * limites pela tela, sem depender de redeploy.
 */

import type { Db } from '../db/index.ts';
import type { PersonaConfig } from '../integracoes/ia.ts';
import { regrasPadrao, type RegrasEnvio } from './regras.ts';

const CHAVE_PERSONA = 'persona';
const CHAVE_REGRAS = 'regras';

export function personaPadrao(): PersonaConfig {
  return {
    nomeEmpresa: 'nossa empresa',
    nomeAtendente: 'Equipe comercial',
    tom: 'caloroso, direto, próximo — como uma pessoa real do time escrevendo, não um anúncio',
    diretrizes: '',
  };
}

async function lerConfig<T>(db: Db, chave: string, padrao: T): Promise<T> {
  const row = await db.get<{ valor: string }>('SELECT valor FROM config WHERE chave = ?', [chave]);
  if (!row) return padrao;
  try {
    return { ...padrao, ...JSON.parse(row.valor) } as T;
  } catch {
    return padrao;
  }
}

async function gravarConfig(db: Db, chave: string, valor: unknown, userId: string): Promise<void> {
  const agora = new Date().toISOString();
  const existente = await db.get<{ chave: string }>('SELECT chave FROM config WHERE chave = ?', [chave]);
  if (existente) {
    await db.run('UPDATE config SET valor = ?, atualizado_em = ?, atualizado_por = ? WHERE chave = ?',
      [JSON.stringify(valor), agora, userId, chave]);
  } else {
    await db.run('INSERT INTO config (chave, valor, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?)',
      [chave, JSON.stringify(valor), agora, userId]);
  }
}

export async function obterPersona(db: Db): Promise<PersonaConfig> {
  return lerConfig(db, CHAVE_PERSONA, personaPadrao());
}

export async function definirPersona(db: Db, persona: PersonaConfig, userId: string): Promise<void> {
  await gravarConfig(db, CHAVE_PERSONA, persona, userId);
}

export async function obterRegras(db: Db): Promise<RegrasEnvio> {
  return lerConfig(db, CHAVE_REGRAS, regrasPadrao());
}

export async function definirRegras(db: Db, regras: RegrasEnvio, userId: string): Promise<void> {
  await gravarConfig(db, CHAVE_REGRAS, regras, userId);
}
