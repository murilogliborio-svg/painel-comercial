/**
 * Camada HTTP: roteador, parsing de corpo, cabeçalhos de segurança e
 * tratamento de erro. Idêntico ao painel-comercial (server/src/http/servidor.ts)
 * — mesma razão para não usar framework: menos superfície de supply chain
 * num sistema que fala com clientes reais e guarda telefone/conversa.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface Requisicao {
  metodo: string;
  caminho: string;
  query: URLSearchParams;
  params: Record<string, string>;
  cabecalhos: IncomingMessage['headers'];
  cookies: Record<string, string>;
  ip: string;
  userAgent: string | null;
  requestId: string;
  corpo: unknown;
  binario: Buffer | null;
  bruto: IncomingMessage;
  ctx: Record<string, unknown>;
}

export interface Resposta {
  status: number;
  corpo?: unknown;
  texto?: string;
  buffer?: Buffer;
  cabecalhos?: Record<string, string>;
  cookies?: CookieDef[];
}

export interface CookieDef {
  nome: string;
  valor: string;
  maxAgeSegundos?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  caminho?: string;
  expiraJa?: boolean;
}

export type Handler = (req: Requisicao) => Promise<Resposta> | Resposta;

export class ErroHttp extends Error {
  readonly status: number;
  readonly codigo: string;
  readonly detalhe: unknown;

  constructor(status: number, message: string, codigo = 'erro', detalhe?: unknown) {
    super(message);
    this.name = 'ErroHttp';
    this.status = status;
    this.codigo = codigo;
    this.detalhe = detalhe;
  }
}

export const erro = {
  requisicao: (m: string, d?: unknown) => new ErroHttp(400, m, 'requisicao_invalida', d),
  naoAutenticado: (m = 'Sessão inválida ou expirada.') => new ErroHttp(401, m, 'nao_autenticado'),
  proibido: (m = 'Você não tem permissão para esta operação.') => new ErroHttp(403, m, 'proibido'),
  naoEncontrado: (m = 'Recurso não encontrado.') => new ErroHttp(404, m, 'nao_encontrado'),
  conflito: (m: string) => new ErroHttp(409, m, 'conflito'),
  grande: (m = 'Conteúdo excede o tamanho permitido.') => new ErroHttp(413, m, 'muito_grande'),
  excesso: (m = 'Tentativas demais. Aguarde e tente novamente.') => new ErroHttp(429, m, 'excesso'),
};

// ---------------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------------

interface Rota {
  metodo: string;
  segmentos: string[];
  handler: Handler;
}

export class Roteador {
  #rotas: Rota[] = [];
  #middlewares: Array<(req: Requisicao) => Promise<void> | void> = [];

  usar(mw: (req: Requisicao) => Promise<void> | void): this {
    this.#middlewares.push(mw);
    return this;
  }

  rota(metodo: string, caminho: string, handler: Handler): this {
    this.#rotas.push({
      metodo: metodo.toUpperCase(),
      segmentos: caminho.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(c: string, h: Handler): this { return this.rota('GET', c, h); }
  post(c: string, h: Handler): this { return this.rota('POST', c, h); }
  put(c: string, h: Handler): this { return this.rota('PUT', c, h); }
  patch(c: string, h: Handler): this { return this.rota('PATCH', c, h); }
  delete(c: string, h: Handler): this { return this.rota('DELETE', c, h); }

  resolver(metodo: string, caminho: string): { handler: Handler; params: Record<string, string> } | null {
    const partes = caminho.split('/').filter(Boolean);
    let houveCaminho = false;

    for (const r of this.#rotas) {
      if (r.segmentos.length !== partes.length) continue;
      const params: Record<string, string> = {};
      let casou = true;
      for (let i = 0; i < r.segmentos.length; i++) {
        const seg = r.segmentos[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(partes[i]!);
        } else if (seg !== partes[i]) {
          casou = false;
          break;
        }
      }
      if (!casou) continue;
      houveCaminho = true;
      if (r.metodo === metodo) return { handler: r.handler, params };
    }

    if (houveCaminho) throw new ErroHttp(405, 'Método não permitido para esta rota.', 'metodo_invalido');
    return null;
  }

  get middlewares() { return this.#middlewares; }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function lerCookies(cabecalho: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cabecalho) return out;
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i < 1) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (nome) {
      try { out[nome] = decodeURIComponent(valor); } catch { out[nome] = valor; }
    }
  }
  return out;
}

export function serializarCookie(c: CookieDef): string {
  const partes = [`${c.nome}=${c.expiraJa ? '' : encodeURIComponent(c.valor)}`];
  partes.push(`Path=${c.caminho ?? '/'}`);
  partes.push(`SameSite=${c.sameSite ?? 'Strict'}`);
  if (c.httpOnly !== false) partes.push('HttpOnly');
  if (c.secure !== false) partes.push('Secure');
  if (c.expiraJa) partes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  else if (c.maxAgeSegundos !== undefined) partes.push(`Max-Age=${Math.floor(c.maxAgeSegundos)}`);
  return partes.join('; ');
}

// ---------------------------------------------------------------------------
// Cabeçalhos de segurança
// ---------------------------------------------------------------------------

export function cabecalhosSeguranca(https: boolean): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');

  const h: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (https) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

// ---------------------------------------------------------------------------
// Corpo da requisição
// ---------------------------------------------------------------------------

async function lerCorpo(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declarado = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declarado) && declarado > maxBytes) throw erro.grande();

  return new Promise((resolve, reject) => {
    const pedacos: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(erro.grande());
        req.destroy();
        return;
      }
      pedacos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

export interface OpcoesServidor {
  roteador: Roteador;
  https: boolean;
  confiarProxy: boolean;
  maxJsonBytes: number;
  maxUploadBytes: number;
  origemPublica: string;
  aoLogar?: (linha: Record<string, unknown>) => void;
}

function ipDe(req: IncomingMessage, confiarProxy: boolean): string {
  if (confiarProxy) {
    const xff = req.headers['x-forwarded-for'];
    const bruto = Array.isArray(xff) ? xff[0] : xff;
    const primeiro = bruto?.split(',')[0]?.trim();
    if (primeiro) return primeiro;
  }
  return req.socket.remoteAddress ?? 'desconhecido';
}

export function criarServidor(opts: OpcoesServidor): Server {
  const seguranca = cabecalhosSeguranca(opts.https);

  return createServer(async (bruto: IncomingMessage, res: ServerResponse) => {
    const inicio = Date.now();
    const requestId = randomUUID();
    let status = 500;
    let caminho = '/';

    try {
      const url = new URL(bruto.url ?? '/', opts.origemPublica);
      caminho = url.pathname;
      const metodo = (bruto.method ?? 'GET').toUpperCase();

      const req: Requisicao = {
        metodo,
        caminho,
        query: url.searchParams,
        params: {},
        cabecalhos: bruto.headers,
        cookies: lerCookies(bruto.headers.cookie),
        ip: ipDe(bruto, opts.confiarProxy),
        userAgent: (bruto.headers['user-agent'] as string | undefined) ?? null,
        requestId,
        corpo: undefined,
        binario: null,
        bruto,
        ctx: {},
      };

      const ehHead = metodo === 'HEAD';
      const resolvido = opts.roteador.resolver(ehHead ? 'GET' : metodo, caminho);
      if (!resolvido) throw erro.naoEncontrado();
      req.params = resolvido.params;

      if (metodo !== 'GET' && metodo !== 'HEAD') {
        const tipo = String(bruto.headers['content-type'] ?? '');
        if (tipo.startsWith('application/octet-stream')) {
          req.binario = await lerCorpo(bruto, opts.maxUploadBytes);
        } else {
          const buf = await lerCorpo(bruto, opts.maxJsonBytes);
          if (buf.length > 0) {
            if (!tipo.startsWith('application/json')) {
              throw erro.requisicao('Content-Type deve ser application/json.');
            }
            try {
              req.corpo = JSON.parse(buf.toString('utf8'));
            } catch {
              throw erro.requisicao('Corpo não é um JSON válido.');
            }
            if (typeof req.corpo !== 'object' || req.corpo === null || Array.isArray(req.corpo)) {
              throw erro.requisicao('Corpo deve ser um objeto JSON.');
            }
          } else {
            req.corpo = {};
          }
        }
      }

      for (const mw of opts.roteador.middlewares) await mw(req);

      const resposta = await resolvido.handler(req);
      status = resposta.status;
      enviar(res, resposta, seguranca, requestId, ehHead);
    } catch (e) {
      const r = respostaDeErro(e, requestId);
      status = r.status;
      enviar(res, r, seguranca, requestId, (bruto.method ?? '').toUpperCase() === 'HEAD');
      if (r.status >= 500) {
        opts.aoLogar?.({ nivel: 'erro', requestId, caminho, erro: String(e), stack: (e as Error)?.stack });
      }
    } finally {
      opts.aoLogar?.({
        nivel: 'acesso',
        requestId,
        metodo: bruto.method,
        caminho,
        status,
        ms: Date.now() - inicio,
      });
    }
  });
}

function respostaDeErro(e: unknown, requestId: string): Resposta {
  if (e instanceof ErroHttp) {
    return {
      status: e.status,
      corpo: { erro: e.codigo, mensagem: e.message, detalhe: e.detalhe, requestId },
    };
  }
  return {
    status: 500,
    corpo: {
      erro: 'interno',
      mensagem: 'Erro interno. Informe o código abaixo ao suporte.',
      requestId,
    },
  };
}

function enviar(
  res: ServerResponse,
  r: Resposta,
  seguranca: Record<string, string>,
  requestId: string,
  semCorpo = false,
): void {
  if (res.headersSent) return;

  const cab: Record<string, string> = { ...seguranca, 'X-Request-Id': requestId, ...(r.cabecalhos ?? {}) };

  let corpo: Buffer;
  if (r.buffer) {
    corpo = r.buffer;
  } else if (r.texto !== undefined) {
    corpo = Buffer.from(r.texto, 'utf8');
    cab['Content-Type'] ??= 'text/plain; charset=utf-8';
  } else if (r.corpo !== undefined) {
    corpo = Buffer.from(JSON.stringify(r.corpo), 'utf8');
    cab['Content-Type'] = 'application/json; charset=utf-8';
  } else {
    corpo = Buffer.alloc(0);
  }

  cab['Content-Length'] = String(corpo.length);
  if (r.cookies?.length) {
    res.setHeader('Set-Cookie', r.cookies.map(serializarCookie));
  }
  res.writeHead(r.status, cab);
  res.end(semCorpo ? undefined : corpo);
}
