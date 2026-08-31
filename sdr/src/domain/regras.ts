/**
 * Motor de regras de envio autônomo — o "freio de mão" da automação.
 *
 * O time decidiu que a I.A. envia sozinha (sem aprovação humana por
 * mensagem), então esta é a única barreira entre um lead e uma mensagem
 * automática. Toda regra aqui é conservadora de propósito: na dúvida, NÃO
 * envia e deixa para um humano decidir. É função pura — sem I/O — para que
 * cada regra seja testável isoladamente (ver test/regras.test.ts).
 */

export interface RegrasEnvio {
  /** Hora de início da janela comercial (0–23, inclusive). */
  horarioInicio: number;
  /** Hora de fim da janela comercial (0–23, exclusive). */
  horarioFim: number;
  /** Dias da semana permitidos: 0=domingo .. 6=sábado. */
  diasPermitidos: number[];
  /** Teto global de mensagens automáticas por dia, somando todos os leads. */
  limiteMsgsPorDia: number;
  /** Intervalo mínimo, em horas, entre duas mensagens automáticas ao mesmo lead. */
  intervaloMinHoras: number;
  /** Depois de tantas mensagens seguidas sem resposta, pausa e pede humano. */
  maxSequenciaSemResposta: number;
  /** Palavras/expressões que, se aparecerem numa resposta do lead, disparam opt-out. */
  palavrasOptOut: string[];
  /**
   * Sequência de aquecimento: cada posição é um passo, com o número de dias
   * de espera desde o passo anterior (posição 0 = primeira mensagem, espera
   * a partir da criação do lead) e o objetivo passado para a I.A. gerar o texto.
   */
  passos: Array<{ diasDeEspera: number; objetivo: string }>;
}

export function regrasPadrao(): RegrasEnvio {
  return {
    horarioInicio: 9,
    horarioFim: 19,
    diasPermitidos: [1, 2, 3, 4, 5],
    limiteMsgsPorDia: 60,
    intervaloMinHoras: 48,
    maxSequenciaSemResposta: 3,
    palavrasOptOut: [
      'parar', 'para de mandar', 'não quero mais', 'nao quero mais', 'descadastrar',
      'sair da lista', 'remover meu contato', 'pare de me chamar', 'stop',
    ],
    passos: [
      { diasDeEspera: 0, objetivo: 'Primeiro contato: apresentação breve e calorosa, sem pedir nada ainda, mostrando que existe uma pessoa real acompanhando o interesse do lead.' },
      { diasDeEspera: 3, objetivo: 'Reforço leve: retomar contato com uma pergunta simples e aberta, mostrando disponibilidade, sem pressão.' },
      { diasDeEspera: 7, objetivo: 'Convite direto para uma conversa ou próximo passo concreto (ligação, visita, proposta), deixando fácil para o lead responder.' },
    ],
  };
}

const ESTAGIOS_SEM_AUTOMACAO = new Set([
  'respondeu', 'quente', 'convertido', 'perdido', 'pausado',
]);

export interface Lead {
  estagio: string;
  opt_out: number;
  automacao_ativa: number;
  sequencia_passo: number;
  proxima_mensagem_em: string | null;
  mensagens_sem_resposta: number;
}

export interface Elegibilidade {
  elegivel: boolean;
  motivo?: string;
}

export function dentroDaJanelaComercial(regras: RegrasEnvio, agora: Date): boolean {
  const dia = agora.getDay();
  if (!regras.diasPermitidos.includes(dia)) return false;
  const hora = agora.getHours();
  return hora >= regras.horarioInicio && hora < regras.horarioFim;
}

export function contemOptOut(texto: string, palavras: string[]): boolean {
  const normalizado = texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return palavras.some((p) => normalizado.includes(
    p.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
  ));
}

/**
 * Decide se ESTE lead pode receber a próxima mensagem automática agora.
 * Não decide o teto diário global — isso depende de quantas mensagens já
 * saíram hoje no sistema inteiro, então fica em mensagens.ts (que tem acesso
 * ao banco). Aqui é só o que dá para decidir olhando o próprio lead.
 */
export function leadElegivel(lead: Lead, regras: RegrasEnvio, agora: Date): Elegibilidade {
  if (lead.opt_out) return { elegivel: false, motivo: 'opt_out' };
  if (!lead.automacao_ativa) return { elegivel: false, motivo: 'automacao_pausada_manualmente' };
  if (ESTAGIOS_SEM_AUTOMACAO.has(lead.estagio)) return { elegivel: false, motivo: `estagio_${lead.estagio}` };
  if (lead.sequencia_passo >= regras.passos.length) return { elegivel: false, motivo: 'sequencia_concluida' };
  if (lead.mensagens_sem_resposta >= regras.maxSequenciaSemResposta) {
    return { elegivel: false, motivo: 'sem_resposta_excedeu_limite' };
  }
  if (!dentroDaJanelaComercial(regras, agora)) return { elegivel: false, motivo: 'fora_horario_comercial' };
  if (lead.proxima_mensagem_em && Date.parse(lead.proxima_mensagem_em) > agora.getTime()) {
    return { elegivel: false, motivo: 'ainda_nao_venceu_intervalo' };
  }
  return { elegivel: true };
}

/** Próximo horário em que o passo seguinte da sequência pode ser enviado. */
export function calcularProximaMensagemEm(
  regras: RegrasEnvio,
  proximoPasso: number,
  agora: Date,
): string | null {
  const passo = regras.passos[proximoPasso];
  if (!passo) return null;
  const alvo = new Date(agora.getTime() + passo.diasDeEspera * 86_400_000);
  return alvo.toISOString();
}

export function objetivoDoPasso(regras: RegrasEnvio, passo: number): string {
  return regras.passos[passo]?.objetivo ?? 'Retomar contato de forma breve e cordial.';
}
