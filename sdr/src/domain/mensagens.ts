/**
 * Orquestração: liga regras + geração por I.A. + envio por WhatsApp + banco
 * + auditoria. É o único lugar que decide "mandar ou não mandar" de verdade
 * — regras.ts só calcula, quem executa e persiste é este módulo.
 */

import type { Db } from '../db/index.ts';
import { ulid } from '../lib/ids.ts';
import type { Auditor } from '../lib/auditoria.ts';
import { gerarMensagem, ErroIA, type PersonaConfig } from '../integracoes/ia.ts';
import { enviar as enviarWhatsapp, type ConfigWhatsapp } from '../integracoes/whatsapp.ts';
import {
  leadElegivel, calcularProximaMensagemEm, objetivoDoPasso, contemOptOut, type RegrasEnvio,
} from './regras.ts';
import {
  listarLeadsDevidos, listarMensagens, avancarSequencia, marcarOptOut, registrarResposta,
  contarEnviadasHoje, buscarLeadPorTelefone, type Lead,
} from './leads.ts';

export interface ConfigIA {
  apiKey: string | null;
  modelo: string;
  maxTokens: number;
}

export interface ResultadoVarredura {
  leadId: string;
  enviado: boolean;
  motivo: string;
}

async function registrarMensagem(
  db: Db,
  leadId: string,
  direcao: 'saida' | 'entrada',
  texto: string,
  status: 'enviada' | 'simulada' | 'falhou' | 'recebida',
  opts: { geradaPorIa?: boolean; erro?: string | null; idExterno?: string | null } = {},
): Promise<void> {
  const agora = new Date().toISOString();
  await db.run(
    `INSERT INTO mensagens
       (id, lead_id, direcao, canal, texto, gerada_por_ia, status, erro,
        mensagem_externa_id, criado_em, enviada_em)
     VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(), leadId, direcao, texto, opts.geradaPorIa ? 1 : 0, status,
      opts.erro ?? null, opts.idExterno ?? null, agora,
      status === 'enviada' || status === 'simulada' ? agora : null,
    ],
  );
}

/**
 * Processa um lead elegível: gera a mensagem, tenta enviar, grava resultado
 * e agenda o próximo passo (ou encerra a sequência). Nunca lança — erro de
 * I.A. ou de WhatsApp vira um resultado "não enviado" com o motivo, para a
 * varredura seguir para o próximo lead sem cair inteira por causa de um.
 */
export async function processarLead(
  db: Db,
  lead: Lead,
  persona: PersonaConfig,
  regras: RegrasEnvio,
  cfgIa: ConfigIA,
  cfgWhatsapp: ConfigWhatsapp,
  auditor: Auditor,
  agora: Date = new Date(),
): Promise<ResultadoVarredura> {
  const elegibilidade = leadElegivel(lead, regras, agora);
  if (!elegibilidade.elegivel) {
    return { leadId: lead.id, enviado: false, motivo: elegibilidade.motivo! };
  }

  const totalHoje = await contarEnviadasHoje(db, agora);
  if (totalHoje >= regras.limiteMsgsPorDia) {
    return { leadId: lead.id, enviado: false, motivo: 'teto_diario_atingido' };
  }

  const historicoBruto = await listarMensagens(db, lead.id, 20);
  const historico = historicoBruto.map((h) => ({
    direcao: (h as { direcao: 'saida' | 'entrada' }).direcao,
    texto: (h as { texto: string }).texto,
  }));

  let texto: string;
  try {
    texto = await gerarMensagem(
      {
        persona,
        lead: { nome: lead.nome, origem: lead.origem, contexto: lead.contexto },
        objetivoPasso: objetivoDoPasso(regras, lead.sequencia_passo),
        historico,
      },
      cfgIa,
    );
  } catch (e) {
    const motivo = e instanceof ErroIA ? e.codigo : 'erro_ia_desconhecido';
    await auditor({
      acao: 'mensagem.falhou', entidade: 'lead', entidadeId: lead.id,
      detalhe: { etapa: 'geracao', motivo, erro: String(e) },
    });
    return { leadId: lead.id, enviado: false, motivo: `falha_geracao:${motivo}` };
  }

  const envio = await enviarWhatsapp(cfgWhatsapp, lead.telefone, texto);
  const proximoPasso = lead.sequencia_passo + 1;
  const proximaEm = calcularProximaMensagemEm(regras, proximoPasso, agora);
  const novoEstagio = proximoPasso >= regras.passos.length ? 'aguardando_resposta' : 'aquecendo';

  if (!envio.ok) {
    await registrarMensagem(db, lead.id, 'saida', texto, 'falhou', { geradaPorIa: true, erro: envio.erro });
    await auditor({
      acao: 'mensagem.falhou', entidade: 'lead', entidadeId: lead.id,
      detalhe: { etapa: 'envio', erro: envio.erro },
    });
    return { leadId: lead.id, enviado: false, motivo: `falha_envio:${envio.erro ?? 'desconhecida'}` };
  }

  await registrarMensagem(db, lead.id, 'saida', texto, envio.simulado ? 'simulada' : 'enviada', {
    geradaPorIa: true, idExterno: envio.idExterno,
  });
  await avancarSequencia(db, lead.id, proximoPasso, proximaEm, novoEstagio);
  await auditor({
    acao: 'mensagem.enviada', entidade: 'lead', entidadeId: lead.id,
    detalhe: { passo: lead.sequencia_passo, simulado: envio.simulado },
  });

  return { leadId: lead.id, enviado: true, motivo: envio.simulado ? 'enviado_simulado' : 'enviado' };
}

/** Varre os leads devidos e processa cada um. Chamada pelo temporizador em main.ts. */
export async function varrerLeadsDevidos(
  db: Db,
  persona: PersonaConfig,
  regras: RegrasEnvio,
  cfgIa: ConfigIA,
  cfgWhatsapp: ConfigWhatsapp,
  auditor: Auditor,
  agora: Date = new Date(),
): Promise<ResultadoVarredura[]> {
  const devidos = await listarLeadsDevidos(db, agora.toISOString());
  const resultados: ResultadoVarredura[] = [];
  for (const lead of devidos) {
    resultados.push(await processarLead(db, lead, persona, regras, cfgIa, cfgWhatsapp, auditor, agora));
  }
  return resultados;
}

/**
 * Trata uma mensagem recebida do lead: grava, detecta opt-out e, em
 * qualquer caso de resposta real, tira o lead da automação — a partir daqui
 * é conversa humana. Isso é o que torna "a I.A. envia sozinha" compatível
 * com "sempre humano": o robô cuida só do contato frio antes de existir
 * diálogo de verdade.
 */
export async function tratarMensagemRecebida(
  db: Db,
  auditor: Auditor,
  leadId: string,
  texto: string,
  regras: RegrasEnvio,
  idExterno: string,
): Promise<void> {
  await registrarMensagem(db, leadId, 'entrada', texto, 'recebida', { idExterno });

  if (contemOptOut(texto, regras.palavrasOptOut)) {
    await marcarOptOut(db, leadId);
    await auditor({ acao: 'lead.opt_out', entidade: 'lead', entidadeId: leadId, detalhe: { texto } });
    return;
  }

  await registrarResposta(db, leadId);
  await auditor({ acao: 'mensagem.recebida', entidade: 'lead', entidadeId: leadId });
}

export { buscarLeadPorTelefone };
