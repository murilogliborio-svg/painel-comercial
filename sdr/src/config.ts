/**
 * Configuração da aplicação, lida do ambiente e validada na inicialização.
 * O processo se recusa a subir com configuração insegura — mesmo princípio
 * do painel-comercial (server/src/config.ts).
 *
 * Duas credenciais externas são OPCIONAIS de propósito: sem ANTHROPIC_API_KEY
 * a I.A. não gera mensagem nenhuma (a tela avisa e a fila fica parada); sem
 * WHATSAPP_TOKEN o envio roda em MODO SIMULADO — grava a mensagem como se
 * tivesse sido enviada, sem tocar em nenhuma API externa. Isso permite montar
 * e testar todo o funil (persona, regras, sequência) antes de ligar o canal
 * de verdade, e é o padrão de segurança: nada sai para um cliente real até
 * alguém entrar deliberadamente nas variáveis de produção.
 */

import { randomBytes } from 'node:crypto';

export type Ambiente = 'producao' | 'desenvolvimento' | 'teste';

export interface Config {
  ambiente: Ambiente;
  porta: number;
  host: string;
  databaseUrl: string;
  origemPublica: string;
  https: boolean;
  segredoSenha: string;

  sessao: {
    duracaoMs: number;
    inatividadeMs: number;
    nomeCookie: string;
    nomeCookieCsrf: string;
  };

  login: {
    maxTentativas: number;
    bloqueioMs: number;
    maxPorIp: number;
    janelaMs: number;
  };

  maxJsonBytes: number;

  retencaoAuditoriaDias: number;
  confiarProxy: boolean;

  ia: {
    /** null quando ANTHROPIC_API_KEY não está definida: a geração fica desligada. */
    apiKey: string | null;
    modelo: string;
    maxTokens: number;
  };

  whatsapp: {
    /** 'simulado' até TODAS as credenciais reais estarem presentes. */
    modo: 'simulado' | 'real';
    token: string | null;
    phoneNumberId: string | null;
    verifyToken: string | null;
    apiVersion: string;
  };

  /** Intervalo da varredura que dispara a próxima mensagem automática devida. */
  varreduraMs: number;
}

class ErroConfig extends Error {
  constructor(msg: string) {
    super(`Configuração inválida: ${msg}`);
    this.name = 'ErroConfig';
  }
}

function num(nome: string, valor: string | undefined, padrao: number): number {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) throw new ErroConfig(`${nome} deve ser um número positivo.`);
  return n;
}

function bool(valor: string | undefined, padrao: boolean): boolean {
  if (valor === undefined || valor === '') return padrao;
  return valor === '1' || valor.toLowerCase() === 'true';
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bruto = (env.NODE_ENV ?? 'desenvolvimento').toLowerCase();
  const ambiente: Ambiente =
    bruto === 'production' || bruto === 'producao' ? 'producao'
    : bruto === 'test' || bruto === 'teste' ? 'teste'
    : 'desenvolvimento';

  const producao = ambiente === 'producao';

  const origemPublica = (
    env.APP_URL || env.RENDER_EXTERNAL_URL || env.RAILWAY_PUBLIC_DOMAIN_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    'http://localhost:8081'
  ).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(origemPublica);
  } catch {
    throw new ErroConfig(`APP_URL não é uma URL válida: "${origemPublica}".`);
  }

  const https = url.protocol === 'https:';
  if (producao && !https) {
    throw new ErroConfig(
      'Em produção, APP_URL deve usar https. Cookies de sessão sem a flag Secure ' +
      'trafegam em claro e podem ser capturados na rede.',
    );
  }

  const databaseUrl = env.DATABASE_URL ?? 'sqlite:./data/app.db';

  let segredoSenha = env.SECRET_KEY ?? '';
  if (!segredoSenha) {
    if (producao) {
      throw new ErroConfig(
        'SECRET_KEY é obrigatória em produção. Gere uma com: openssl rand -base64 48',
      );
    }
    segredoSenha = randomBytes(32).toString('base64');
  } else if (segredoSenha.length < 32) {
    throw new ErroConfig('SECRET_KEY deve ter no mínimo 32 caracteres.');
  }

  const waToken = env.WHATSAPP_TOKEN || null;
  const waPhoneId = env.WHATSAPP_PHONE_NUMBER_ID || null;
  const waVerify = env.WHATSAPP_VERIFY_TOKEN || null;
  // Só liga o modo real com as três credenciais presentes. Faltando qualquer
  // uma, cai para simulado — nunca sobe "meio configurado" tentando falar
  // com a API do WhatsApp sem o necessário.
  const waModoReal = !!(waToken && waPhoneId && waVerify) && env.WHATSAPP_MODO !== 'simulado';

  return {
    ambiente,
    porta: num('PORT', env.PORT, 8081),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    origemPublica,
    https,
    segredoSenha,
    sessao: {
      duracaoMs: num('SESSION_MAX_HOURS', env.SESSION_MAX_HOURS, 12) * 3_600_000,
      inatividadeMs: num('SESSION_IDLE_MINUTES', env.SESSION_IDLE_MINUTES, 60) * 60_000,
      nomeCookie: https ? '__Host-sdr-sessao' : 'sdr-sessao',
      nomeCookieCsrf: https ? '__Host-sdr-csrf' : 'sdr-csrf',
    },
    login: {
      maxTentativas: num('LOGIN_MAX_TENTATIVAS', env.LOGIN_MAX_TENTATIVAS, 5),
      bloqueioMs: num('LOGIN_BLOQUEIO_MINUTOS', env.LOGIN_BLOQUEIO_MINUTOS, 15) * 60_000,
      maxPorIp: num('LOGIN_MAX_POR_IP', env.LOGIN_MAX_POR_IP, 20),
      janelaMs: num('LOGIN_JANELA_MINUTOS', env.LOGIN_JANELA_MINUTOS, 15) * 60_000,
    },
    maxJsonBytes: num('JSON_MAX_KB', env.JSON_MAX_KB, 256) * 1024,
    retencaoAuditoriaDias: num('RETENCAO_AUDITORIA_DIAS', env.RETENCAO_AUDITORIA_DIAS, 365),
    confiarProxy: bool(env.TRUST_PROXY, producao),
    ia: {
      apiKey: env.ANTHROPIC_API_KEY || null,
      modelo: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      maxTokens: num('ANTHROPIC_MAX_TOKENS', env.ANTHROPIC_MAX_TOKENS, 400),
    },
    whatsapp: {
      modo: waModoReal ? 'real' : 'simulado',
      token: waToken,
      phoneNumberId: waPhoneId,
      verifyToken: waVerify,
      apiVersion: env.WHATSAPP_API_VERSION || 'v20.0',
    },
    varreduraMs: num('VARREDURA_MINUTOS', env.VARREDURA_MINUTOS, 5) * 60_000,
  };
}
