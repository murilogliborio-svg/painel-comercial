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
const CHAVE_QUALIFICACAO = 'qualificacao';
const CHAVE_ALERTA = 'alerta';

export function personaPadrao(): PersonaConfig {
  return {
    nomeEmpresa: 'nossa empresa',
    nomeAtendente: 'Equipe comercial',
    tom: 'caloroso, direto, próximo — como uma pessoa real do time escrevendo, não um anúncio',
    diretrizes: '',
    conhecimento: '',
  };
}

export interface QualificacaoConfig {
  /** Liga/desliga a I.A. continuando a conversa depois que o lead responde. Desligado = sempre humano a partir da resposta. */
  ativa: boolean;
  /** Teto de segurança: quantas mensagens a I.A. manda nessa fase antes de encerrar e passar pra um humano de qualquer forma. */
  maxMensagens: number;
  /** O que a I.A. deve tentar descobrir antes de considerar o lead pronto para um vendedor. */
  objetivo: string;
}

export function qualificacaoPadrao(): QualificacaoConfig {
  return {
    ativa: true,
    maxMensagens: 6,
    objetivo:
      'Número de convidados, data prevista do evento, local desejado (ou se ainda não decidiu) e estilo/tema '
      + 'da festa. Se o lead demonstrar urgência ou pedir preço/orçamento, considere isso suficiente também.',
  };
}

export interface AlertaConfig {
  /** Liga/desliga o aviso pro gestor quando um lead sai da automação fria e responde pela primeira vez. */
  ativo: boolean;
  /** Número (WhatsApp) do gestor que recebe o aviso. */
  telefone: string;
  /** Nome do modelo aprovado na Meta para esse aviso (categoria Utilidade/Marketing, variáveis nomeadas). */
  nomeTemplate: string;
  idioma: string;
  /** Valor a preencher na variável com o nome do destinatário do aviso (ex.: "Murilo"). */
  nomeDestinatario: string;
}

export function alertaPadrao(): AlertaConfig {
  return {
    ativo: false, telefone: '', nomeTemplate: 'alerta_lead_respondeu', idioma: 'pt_BR', nomeDestinatario: '',
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

export async function obterQualificacao(db: Db): Promise<QualificacaoConfig> {
  return lerConfig(db, CHAVE_QUALIFICACAO, qualificacaoPadrao());
}

export async function definirQualificacao(db: Db, cfg: QualificacaoConfig, userId: string): Promise<void> {
  await gravarConfig(db, CHAVE_QUALIFICACAO, cfg, userId);
}

export async function obterAlerta(db: Db): Promise<AlertaConfig> {
  return lerConfig(db, CHAVE_ALERTA, alertaPadrao());
}

export async function definirAlerta(db: Db, cfg: AlertaConfig, userId: string): Promise<void> {
  await gravarConfig(db, CHAVE_ALERTA, cfg, userId);
}
