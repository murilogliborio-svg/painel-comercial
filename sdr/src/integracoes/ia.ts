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
    '',
    'REGRAS FIXAS, NUNCA QUEBRE:',
    '- Escreva em português do Brasil, curto (2 a 4 frases), como quem digita no WhatsApp — não como e-mail.',
    '- Nunca use "prezado(a)", "vimos por meio desta", "informamos que" ou qualquer fórmula de robô/call center.',
    '- Nunca repita a mesma abertura de mensagens anteriores da conversa: varie a frase inicial.',
    '- Não use mais de um emoji, e só se combinar com o tom pedido.',
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
