/**
 * Orquestração: liga regras + geração por I.A. + envio por WhatsApp + banco
 * + auditoria. É o único lugar que decide "mandar ou não mandar" de verdade
 * — regras.ts só calcula, quem executa e persiste é este módulo.
 */

import type { Db } from '../db/index.ts';
import { ulid } from '../lib/ids.ts';
import type { Auditor } from '../lib/auditoria.ts';
import {
  gerarMensagem, gerarRespostaQualificacao, ErroIA, type PersonaConfig,
} from '../integracoes/ia.ts';
import {
  enviar as enviarWhatsapp, enviarTemplate, enviarTemplateNomeado, type ConfigWhatsapp, type ResultadoEnvio,
} from '../integracoes/whatsapp.ts';
import {
  leadElegivel, calcularProximaMensagemEm, objetivoDoPasso, nomeTemplateDoPasso, corpoTemplateDoPasso,
  nomeVariavelDoPasso, janelaDeServicoAtiva, contemOptOut, type RegrasEnvio,
} from './regras.ts';
import type { QualificacaoConfig, AlertaConfig } from './config.ts';
import {
  listarLeadsDevidos, listarMensagens, avancarSequencia, marcarOptOut, registrarResposta,
  avancarQualificacao, encerrarQualificacao, contarEnviadasHoje, buscarLeadPorTelefone, type Lead,
} from './leads.ts';

const AINDA_FRIO = new Set(['novo', 'aquecendo', 'aguardando_resposta']);

async function historicoDoLead(db: Db, leadId: string) {
  const bruto = await listarMensagens(db, leadId, 20);
  return bruto.map((h) => ({
    direcao: (h as { direcao: 'saida' | 'entrada' }).direcao,
    texto: (h as { texto: string }).texto,
  }));
}

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

  // A Cloud API só entrega texto livre dentro de 24h da última mensagem que
  // o LEAD mandou. Como a automação para assim que ele responde (vira
  // "respondeu", fora do fluxo automático), na prática todo envio daqui é
  // fora dessa janela — precisa ser um modelo (template) pré-aprovado pela
  // Meta. Texto livre da I.A. nesse caso seria aceito pela API só pra nunca
  // chegar no celular do lead.
  const janelaAberta = janelaDeServicoAtiva(lead.ultima_resposta_em, agora);

  let texto: string;
  let envio: ResultadoEnvio;

  if (janelaAberta) {
    const historico = await historicoDoLead(db, lead.id);
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
    envio = await enviarWhatsapp(cfgWhatsapp, lead.telefone, texto);
  } else {
    const nomeTemplate = nomeTemplateDoPasso(regras, lead.sequencia_passo);
    if (!nomeTemplate) {
      return { leadId: lead.id, enviado: false, motivo: 'template_nao_configurado' };
    }
    const corpoTemplate = corpoTemplateDoPasso(regras, lead.sequencia_passo);
    const nomeVariavel = nomeVariavelDoPasso(regras, lead.sequencia_passo);
    const marcador = `{{${nomeVariavel || '1'}}}`;
    texto = corpoTemplate
      ? corpoTemplate.replaceAll(marcador, lead.nome)
      : `Mensagem-modelo "${nomeTemplate}" enviada (parâmetro: ${lead.nome}) — cadastre o texto do modelo `
        + 'em Configuração para o painel mostrar a mensagem real.';
    envio = await enviarTemplate(
      cfgWhatsapp, lead.telefone, nomeTemplate, regras.idiomaTemplates, [lead.nome], nomeVariavel || null,
    );
  }

  const proximoPasso = lead.sequencia_passo + 1;
  const proximaEm = calcularProximaMensagemEm(regras, proximoPasso, agora);
  const novoEstagio = proximoPasso >= regras.passos.length ? 'aguardando_resposta' : 'aquecendo';

  if (!envio.ok) {
    await registrarMensagem(db, lead.id, 'saida', texto, 'falhou', { geradaPorIa: true, erro: envio.erro });
    await auditor({
      acao: 'mensagem.falhou', entidade: 'lead', entidadeId: lead.id,
      detalhe: { etapa: 'envio', erro: envio.erro },
    });
    console.error(JSON.stringify({
      ts: agora.toISOString(), nivel: 'erro', msg: 'falha ao enviar mensagem via whatsapp (varredura)',
      leadId: lead.id, erro: envio.erro ?? 'desconhecida',
    }));
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
 * Fase 2: o lead acabou de responder e a qualificação por I.A. está ativa
 * para ele. Gera UMA resposta reativa, manda, e decide se encerra a fase
 * (qualificação completa, teto de mensagens batido, erro) ou continua para
 * a próxima resposta do lead. Nunca lança — qualquer erro encerra a
 * qualificação em vez de deixar o lead preso num estado quebrado.
 */
async function processarQualificacao(
  db: Db,
  lead: Lead,
  persona: PersonaConfig,
  regras: RegrasEnvio,
  qualificacao: QualificacaoConfig,
  cfgIa: ConfigIA,
  cfgWhatsapp: ConfigWhatsapp,
  auditor: Auditor,
  alerta: AlertaConfig,
  agora: Date,
): Promise<void> {
  const totalHoje = await contarEnviadasHoje(db, agora);
  if (totalHoje >= regras.limiteMsgsPorDia) {
    await encerrarQualificacao(db, lead.id, { estagio: 'respondeu' });
    return;
  }

  const historico = await historicoDoLead(db, lead.id);
  let resposta;
  try {
    resposta = await gerarRespostaQualificacao(
      {
        persona,
        lead: { nome: lead.nome, origem: lead.origem, contexto: lead.contexto },
        objetivo: qualificacao.objetivo,
        historico,
      },
      cfgIa,
    );
  } catch (e) {
    const motivo = e instanceof ErroIA ? e.codigo : 'erro_ia_desconhecido';
    await auditor({
      acao: 'mensagem.falhou', entidade: 'lead', entidadeId: lead.id,
      detalhe: { etapa: 'qualificacao_geracao', motivo, erro: String(e) },
    });
    await encerrarQualificacao(db, lead.id, { estagio: 'respondeu' });
    return;
  }

  const envio = await enviarWhatsapp(cfgWhatsapp, lead.telefone, resposta.mensagem);
  if (!envio.ok) {
    await registrarMensagem(db, lead.id, 'saida', resposta.mensagem, 'falhou', {
      geradaPorIa: true, erro: envio.erro,
    });
    await auditor({
      acao: 'mensagem.falhou', entidade: 'lead', entidadeId: lead.id,
      detalhe: { etapa: 'qualificacao_envio', erro: envio.erro },
    });
    await encerrarQualificacao(db, lead.id, { estagio: 'respondeu' });
    return;
  }

  await registrarMensagem(db, lead.id, 'saida', resposta.mensagem, envio.simulado ? 'simulada' : 'enviada', {
    geradaPorIa: true, idExterno: envio.idExterno,
  });

  if (resposta.precisaAtencaoHumanaAgora) {
    await enviarAlertaResposta(cfgWhatsapp, alerta, lead, auditor);
  }

  const novoContador = lead.qualificacao_mensagens + 1;
  const capou = novoContador >= qualificacao.maxMensagens;
  if (resposta.qualificacaoCompleta || capou) {
    await encerrarQualificacao(db, lead.id, {
      estagio: resposta.qualificacaoCompleta ? 'quente' : 'respondeu',
      resumo: resposta.precisaAtencaoHumanaAgora
        ? `Lead perguntou se está falando com um robô/I.A. — assumir agora. ${resposta.resumo ?? ''}`.trim()
        : resposta.resumo,
    });
    await auditor({
      acao: 'mensagem.enviada', entidade: 'lead', entidadeId: lead.id,
      detalhe: {
        qualificacao: true, encerrada: true,
        motivo: resposta.precisaAtencaoHumanaAgora ? 'perguntou_se_e_robo' : (resposta.qualificacaoCompleta ? 'completa' : 'teto_atingido'),
      },
    });
  } else {
    await avancarQualificacao(db, lead.id, novoContador);
    await auditor({
      acao: 'mensagem.enviada', entidade: 'lead', entidadeId: lead.id,
      detalhe: { qualificacao: true, encerrada: false, passo: novoContador },
    });
  }
}

/**
 * Trata uma mensagem recebida do lead: grava, detecta opt-out e, na
 * primeira resposta real, tira o lead da automação de aquecimento frio.
 * Se a qualificação por I.A. estiver ligada, ela assume a partir daqui —
 * reativamente, uma resposta por vez — até decidir que já sabe o
 * suficiente (ou bater o teto de segurança); só então vira 100% humano.
 * Se estiver desligada, "sempre humano" continua valendo já na primeira
 * resposta, como antes.
 */
/**
 * Avisa o gestor, por WhatsApp, que um lead acabou de sair da automação fria
 * e respondeu — o momento em que ele mais precisa saber, porque a partir daí
 * a I.A. (ou um humano) está conduzindo uma conversa real. Nunca lança: um
 * alerta que falha não pode derrubar o tratamento da mensagem do lead.
 */
async function enviarAlertaResposta(
  cfgWhatsapp: ConfigWhatsapp,
  alerta: AlertaConfig,
  lead: Lead,
  auditor: Auditor,
): Promise<void> {
  if (!alerta.ativo || !alerta.telefone || !alerta.nomeTemplate) return;
  try {
    const envio = await enviarTemplateNomeado(cfgWhatsapp, alerta.telefone, alerta.nomeTemplate, alerta.idioma, {
      nome: alerta.nomeDestinatario || 'time', lead: lead.nome,
    });
    await auditor({
      acao: envio.ok ? 'alerta.enviado' : 'alerta.falhou',
      entidade: 'lead',
      entidadeId: lead.id,
      detalhe: envio.ok ? null : { erro: envio.erro },
    });
  } catch (e) {
    await auditor({
      acao: 'alerta.falhou', entidade: 'lead', entidadeId: lead.id, detalhe: { erro: String(e) },
    });
  }
}

export async function tratarMensagemRecebida(
  db: Db,
  auditor: Auditor,
  lead: Lead,
  texto: string,
  regras: RegrasEnvio,
  qualificacao: QualificacaoConfig,
  persona: PersonaConfig,
  cfgIa: ConfigIA,
  cfgWhatsapp: ConfigWhatsapp,
  alerta: AlertaConfig,
  idExterno: string,
  agora: Date = new Date(),
): Promise<void> {
  await registrarMensagem(db, lead.id, 'entrada', texto, 'recebida', { idExterno });

  if (contemOptOut(texto, regras.palavrasOptOut)) {
    await marcarOptOut(db, lead.id);
    await auditor({ acao: 'lead.opt_out', entidade: 'lead', entidadeId: lead.id, detalhe: { texto } });
    return;
  }

  const primeiraResposta = AINDA_FRIO.has(lead.estagio);
  await registrarResposta(db, lead.id);
  await auditor({ acao: 'mensagem.recebida', entidade: 'lead', entidadeId: lead.id });

  if (primeiraResposta) {
    await enviarAlertaResposta(cfgWhatsapp, alerta, lead, auditor);
  }

  const podeQualificar = qualificacao.ativa && !!lead.automacao_ativa
    && (primeiraResposta || !!lead.qualificacao_ativa);
  if (!podeQualificar) return;

  await processarQualificacao(db, lead, persona, regras, qualificacao, cfgIa, cfgWhatsapp, auditor, alerta, agora);
}

export { buscarLeadPorTelefone };
