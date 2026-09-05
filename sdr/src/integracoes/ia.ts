/**
 * Geração de mensagem de aquecimento via I.A. (API Messages da Anthropic),
 * chamada com `fetch` nativo do Node — sem SDK, para manter a política de
 * zero dependências de runtime do projeto.
 *
 * O QUE ESTE MÓDULO GARANTE, E O QUE NÃO GARANTE
 * ------------------------------------------------
 * Garante: cada chamada recebe a persona configurada pelo gestor, o contexto
 * do lead e o histórico real da conversa, para que a mensagem soe como uma
 * pessoa da equipe escrevendo — não um formulário preenchido. O prompt pede
 * explicitamente variação de abertura (nunca repetir a mesma frase de
 * template) e proíbe linguagem robótica ("prezado cliente", "informamos que").
 *
 * NÃO garante indistinguibilidade de um humano nem instrui a I.A. a negar
 * que é automatizada se o cliente perguntar diretamente — isso seria
 * enganosivo e cria risco de LGPD/CDC. "Soar humano" aqui é sobre tom e
 * naturalidade, não sobre disfarçar a origem quando questionado.
 */

export class ErroIA extends Error {
  readonly codigo: 'sem_chave' | 'falha_api' | 'resposta_vazia';
  constructor(codigo: 'sem_chave' | 'falha_api' | 'resposta_vazia', mensagem: string) {
    super(mensagem);
    this.name = 'ErroIA';
    this.codigo = codigo;
  }
}

export interface PersonaConfig {
  nomeEmpresa: string;
  nomeAtendente: string;
  tom: string;
  diretrizes: string;
  /** Fatos sobre o negócio (espaços, o que está incluso, como funciona a visita, etc.) — separado de "diretrizes" porque é conhecimento, não comportamento. */
  conhecimento: string;
}

export interface ContextoLead {
  nome: string;
  origem: string | null;
  contexto: string | null;
}

export interface ItemHistorico {
  direcao: 'saida' | 'entrada';
  texto: string;
}

export interface PedidoGeracao {
  persona: PersonaConfig;
  lead: ContextoLead;
  objetivoPasso: string;
  historico: ItemHistorico[];
}

function montarSystemPrompt(persona: PersonaConfig): string {
  return [
    `Você é ${persona.nomeAtendente}, do time comercial da ${persona.nomeEmpresa}, escrevendo `
      + 'mensagens de WhatsApp para aquecer um lead (contato comercial) antes de um consultor humano assumir a conversa.',
    `Tom desejado: ${persona.tom}.`,
    persona.diretrizes ? `Diretrizes adicionais definidas pelo gestor: ${persona.diretrizes}` : '',
    persona.conhecimento
      ? `Conhecimento sobre o negócio (use só o que estiver aqui; não invente o resto):\n${persona.conhecimento}`
      : '',
    '',
    'REGRAS FIXAS, NUNCA QUEBRE:',
    '- Escreva em português do Brasil, curto (2 a 4 frases), como quem digita no WhatsApp — não como e-mail.',
    '- Nunca use "prezado(a)", "vimos por meio desta", "informamos que" ou qualquer fórmula de robô/call center.',
    '- Nunca repita a mesma abertura de mensagens anteriores da conversa: varie a frase inicial.',
    '- Não use mais de um emoji, e só se combinar com o tom pedido.',
    '- Use o primeiro nome do lead pelo menos uma vez na conversa (a saudação inicial é um bom lugar) — mas '
      + 'não repita o nome em toda mensagem, isso soa forçado.',
    '- Não puxe brincadeira, gíria forte ou humor por conta própria. Comece cordial e mais neutro; só fique '
      + 'mais descontraído se o próprio lead demonstrar esse tom primeiro. Rapport se constrói acompanhando '
      + 'a energia de quem responde, nunca impondo a sua.',
    '- Não invente promessa, preço, condição ou prazo que não esteja no contexto fornecido.',
    '- Se o lead pedir para não receber mais mensagens, isso é tratado fora deste texto — não gere respostas para esse caso.',
    '- Se for perguntado diretamente se quem escreve é um robô ou I.A., a orientação da empresa é responder com honestidade; não inclua negação disso na mensagem.',
    '- Devolva SOMENTE o texto da mensagem, sem aspas, sem explicação, sem markdown.',
  ].filter(Boolean).join('\n');
}

function montarMensagemUsuario(lead: ContextoLead, objetivoPasso: string, historico: ItemHistorico[]): string {
  const partes = [
    `Lead: ${lead.nome}`,
    lead.origem ? `Origem do contato: ${lead.origem}` : '',
    lead.contexto ? `Contexto/observações sobre o lead: ${lead.contexto}` : '',
    `Objetivo desta mensagem: ${objetivoPasso}`,
  ];
  if (historico.length > 0) {
    partes.push('', 'Histórico da conversa (mais antiga primeiro):');
    for (const h of historico.slice(-10)) {
      partes.push(`${h.direcao === 'saida' ? 'Nós' : 'Lead'}: ${h.texto}`);
    }
  } else {
    partes.push('', 'Esta é a primeira mensagem para este lead.');
  }
  partes.push('', 'Escreva a próxima mensagem a enviar.');
  return partes.filter(Boolean).join('\n');
}

export async function gerarMensagem(
  opts: PedidoGeracao,
  cfg: { apiKey: string | null; modelo: string; maxTokens: number },
): Promise<string> {
  if (!cfg.apiKey) {
    throw new ErroIA('sem_chave', 'ANTHROPIC_API_KEY não configurada: a geração automática está desligada.');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.modelo,
      max_tokens: cfg.maxTokens,
      system: montarSystemPrompt(opts.persona),
      messages: [
        { role: 'user', content: montarMensagemUsuario(opts.lead, opts.objetivoPasso, opts.historico) },
      ],
    }),
  }).catch((e: unknown) => {
    throw new ErroIA('falha_api', `Falha de rede ao chamar a API de I.A.: ${String(e)}`);
  });

  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new ErroIA('falha_api', `API de I.A. respondeu ${resp.status}: ${corpo.slice(0, 300)}`);
  }

  const json = await resp.json() as {
    content?: Array<{ type: string; text?: string }>;
  };
  const texto = json.content?.find((b) => b.type === 'text')?.text?.trim();
  if (!texto) throw new ErroIA('resposta_vazia', 'A I.A. retornou uma resposta vazia.');
  return texto;
}

/**
 * Fase 2 do funil: o lead já respondeu, e a I.A. continua a conversa
 * (reativamente, uma resposta por vez) para levantar as informações que o
 * gestor definiu como objetivo de qualificação — até decidir que já sabe o
 * suficiente para um vendedor humano assumir. Quem impõe o limite de
 * segurança (teto de mensagens) é quem chama isso, não este módulo.
 *
 * Usa tool-use forçado (tool_choice) em vez de pedir JSON solto no texto:
 * é a forma confiável de obter uma resposta estruturada da Messages API,
 * sem depender de parsear texto livre que a I.A. pode formatar diferente.
 */
export interface PedidoQualificacao {
  persona: PersonaConfig;
  lead: ContextoLead;
  objetivo: string;
  historico: ItemHistorico[];
}

export interface RespostaQualificacao {
  mensagem: string;
  qualificacaoCompleta: boolean;
  resumo: string | null;
}

const FERRAMENTA_QUALIFICACAO = {
  name: 'responder_lead',
  description: 'Registra a próxima mensagem a enviar ao lead e se a qualificação já está completa.',
  input_schema: {
    type: 'object',
    properties: {
      mensagem: {
        type: 'string',
        description: 'A próxima mensagem de WhatsApp para o lead — curta, natural, uma pergunta por vez.',
      },
      qualificacao_completa: {
        type: 'boolean',
        description:
          'true se já se sabe o suficiente sobre o que o lead quer (conforme o objetivo de qualificação) '
          + 'para um vendedor humano assumir a conversa agora, ou se o lead já pediu claramente para falar '
          + 'com uma pessoa/saber preço/agendar. false se ainda vale a pena perguntar mais uma coisa.',
      },
      resumo: {
        type: 'string',
        description:
          'Resumo curto (2-4 linhas) do que foi levantado até agora, para o vendedor ler rápido ao assumir. '
          + 'Preencha SOMENTE quando qualificacao_completa for true.',
      },
    },
    required: ['mensagem', 'qualificacao_completa'],
  },
} as const;

function montarSystemPromptQualificacao(persona: PersonaConfig, objetivo: string): string {
  return [
    `Você é ${persona.nomeAtendente}, do time comercial da ${persona.nomeEmpresa}, conversando por WhatsApp `
      + 'com um lead que acabou de responder. Seu trabalho agora não é mais "chamar atenção" — é ter uma '
      + 'conversa de verdade e entender o que a pessoa precisa, para o time comercial assumir já sabendo o essencial.',
    `Tom desejado: ${persona.tom}.`,
    persona.diretrizes ? `Diretrizes adicionais definidas pelo gestor: ${persona.diretrizes}` : '',
    persona.conhecimento
      ? `Conhecimento sobre o negócio (use só o que estiver aqui; não invente o resto):\n${persona.conhecimento}`
      : '',
    '',
    `O QUE VOCÊ PRECISA DESCOBRIR: ${objetivo}`,
    '',
    'REGRAS FIXAS, NUNCA QUEBRE:',
    '- Uma pergunta por vez — nunca uma lista de perguntas na mesma mensagem.',
    '- Português do Brasil, curto (1 a 3 frases), como quem digita no WhatsApp.',
    '- Nunca use "prezado(a)", "vimos por meio desta", "informamos que" ou qualquer fórmula de robô/call center.',
    '- Use o primeiro nome do lead pelo menos uma vez na conversa (a saudação inicial é um bom lugar) — mas '
      + 'não repita o nome em toda mensagem, isso soa forçado.',
    '- Não puxe brincadeira, gíria forte ou humor por conta própria. Comece cordial e mais neutro; só fique '
      + 'mais descontraído se o próprio lead demonstrar esse tom primeiro. Rapport se constrói acompanhando '
      + 'a energia de quem responde, nunca impondo a sua.',
    '- Não invente promessa, preço, condição ou prazo que não esteja no contexto fornecido.',
    '- Se o lead pedir para falar com uma pessoa, saber preço, ou fechar algo — marque qualificação completa '
      + 'na hora, mesmo sem ter perguntado tudo: não segure a pessoa que já quer avançar.',
    '- Se o lead responder algo que não tem a ver (ou pedir pra parar), marque qualificação completa também: '
      + 'não insista sozinho, deixe para o humano decidir.',
    '- Se for perguntado diretamente se quem escreve é um robô ou I.A., a orientação da empresa é responder '
      + 'com honestidade; não inclua negação disso na mensagem.',
    '- Sempre use a ferramenta responder_lead — nunca responda em texto livre fora dela.',
  ].filter(Boolean).join('\n');
}

function montarMensagemUsuarioQualificacao(lead: ContextoLead, historico: ItemHistorico[]): string {
  const partes = [
    `Lead: ${lead.nome}`,
    lead.origem ? `Origem do contato: ${lead.origem}` : '',
    lead.contexto ? `Contexto/observações sobre o lead: ${lead.contexto}` : '',
    '',
    'Histórico da conversa (mais antiga primeiro):',
  ];
  for (const h of historico.slice(-20)) {
    partes.push(`${h.direcao === 'saida' ? 'Nós' : 'Lead'}: ${h.texto}`);
  }
  partes.push('', 'Responda ao lead agora, usando a ferramenta responder_lead.');
  return partes.filter(Boolean).join('\n');
}

export async function gerarRespostaQualificacao(
  opts: PedidoQualificacao,
  cfg: { apiKey: string | null; modelo: string; maxTokens: number },
): Promise<RespostaQualificacao> {
  if (!cfg.apiKey) {
    throw new ErroIA('sem_chave', 'ANTHROPIC_API_KEY não configurada: a geração automática está desligada.');
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.modelo,
      max_tokens: cfg.maxTokens,
      system: montarSystemPromptQualificacao(opts.persona, opts.objetivo),
      messages: [
        { role: 'user', content: montarMensagemUsuarioQualificacao(opts.lead, opts.historico) },
      ],
      tools: [FERRAMENTA_QUALIFICACAO],
      tool_choice: { type: 'tool', name: FERRAMENTA_QUALIFICACAO.name },
    }),
  }).catch((e: unknown) => {
    throw new ErroIA('falha_api', `Falha de rede ao chamar a API de I.A.: ${String(e)}`);
  });

  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new ErroIA('falha_api', `API de I.A. respondeu ${resp.status}: ${corpo.slice(0, 300)}`);
  }

  const json = await resp.json() as {
    content?: Array<{ type: string; input?: unknown }>;
  };
  const chamada = json.content?.find((b) => b.type === 'tool_use');
  const entrada = chamada?.input as { mensagem?: string; qualificacao_completa?: boolean; resumo?: string } | undefined;
  if (!entrada?.mensagem) throw new ErroIA('resposta_vazia', 'A I.A. não devolveu uma mensagem válida.');

  return {
    mensagem: entrada.mensagem.trim(),
    qualificacaoCompleta: !!entrada.qualificacao_completa,
    resumo: entrada.resumo?.trim() || null,
  };
}
