/**
 * Adaptador de WhatsApp: API oficial da Meta (Cloud API), com `fetch` nativo.
 *
 * MODO SIMULADO
 * --------------
 * Enquanto WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_VERIFY_TOKEN
 * não estiverem TODOS configurados (ver config.ts), `enviar()` não faz
 * nenhuma chamada de rede: grava a mensagem como "simulada" e devolve
 * sucesso. Isso existe para o time poder montar e testar toda a esteira de
 * aquecimento — persona, regras, sequência, painel — sem que nenhuma
 * mensagem real saia para um cliente antes de vocês terem a conta comercial
 * do WhatsApp pronta.
 *
 * Por que a API oficial e não uma biblioteca não-oficial (Baileys/WPPConnect
 * automatizando um número pessoal): a não-oficial roda por engenharia reversa
 * do protocolo do WhatsApp pessoal, viola os termos de uso e o número pode
 * ser banido a qualquer momento — inaceitável se for o número comercial da
 * empresa. A Cloud API é paga por conversa, mas é suportada e estável.
 */

export interface ConfigWhatsapp {
  modo: 'simulado' | 'real';
  token: string | null;
  phoneNumberId: string | null;
  verifyToken: string | null;
  apiVersion: string;
}

export interface ResultadoEnvio {
  ok: boolean;
  simulado: boolean;
  idExterno: string | null;
  erro?: string;
}

/** Normaliza para dígitos apenas, com código do país — formato exigido pela Cloud API. */
export function normalizarTelefone(v: string): string {
  return v.replace(/\D/g, '');
}

export async function enviar(cfg: ConfigWhatsapp, telefone: string, texto: string): Promise<ResultadoEnvio> {
  if (cfg.modo === 'simulado') {
    return { ok: true, simulado: true, idExterno: null };
  }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizarTelefone(telefone),
        type: 'text',
        text: { body: texto },
      }),
    });
    const json = await resp.json().catch(() => ({})) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string };
    };
    if (!resp.ok) {
      return { ok: false, simulado: false, idExterno: null, erro: json.error?.message ?? `HTTP ${resp.status}` };
    }
    return { ok: true, simulado: false, idExterno: json.messages?.[0]?.id ?? null };
  } catch (e) {
    return { ok: false, simulado: false, idExterno: null, erro: String(e) };
  }
}

/**
 * Responde ao desafio de verificação do webhook (GET com hub.mode=subscribe).
 * Devolve o `hub.challenge` a ecoar, ou null se o verify_token não bater.
 */
export function verificarWebhook(
  query: URLSearchParams,
  verifyToken: string | null,
): string | null {
  if (!verifyToken) return null;
  if (query.get('hub.mode') !== 'subscribe') return null;
  if (query.get('hub.verify_token') !== verifyToken) return null;
  return query.get('hub.challenge');
}

export interface MensagemInbound {
  telefone: string;
  texto: string;
  idExterno: string;
}

/**
 * Extrai mensagens de texto recebidas do payload de webhook da Cloud API.
 * O formato tem vários níveis de aninhamento (entry[].changes[].value...);
 * eventos que não são mensagem de texto (status de entrega, mídia) são
 * ignorados aqui — quem chama decide se quer tratá-los.
 */
export function extrairMensagensInbound(payload: unknown): MensagemInbound[] {
  const out: MensagemInbound[] = [];
  const entradas = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entradas)) return out;

  for (const entrada of entradas) {
    const mudancas = (entrada as { changes?: unknown[] })?.changes;
    if (!Array.isArray(mudancas)) continue;
    for (const mudanca of mudancas) {
      const mensagens = (mudanca as { value?: { messages?: unknown[] } })?.value?.messages;
      if (!Array.isArray(mensagens)) continue;
      for (const m of mensagens) {
        const msg = m as { from?: string; id?: string; type?: string; text?: { body?: string } };
        if (msg.type === 'text' && msg.text?.body && msg.from && msg.id) {
          out.push({ telefone: msg.from, texto: msg.text.body, idExterno: msg.id });
        }
      }
    }
  }
  return out;
}
