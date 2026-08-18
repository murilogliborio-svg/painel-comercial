/**
 * Configuração da aplicação, lida do ambiente e validada na inicialização.
 *
 * Princípio: o processo se recusa a subir com configuração inválida ou
 * insegura. Falhar no boot é barato; descobrir em produção que o cookie não
 * era Secure, não é.
 */

import { randomBytes } from 'node:crypto';

export type Ambiente = 'producao' | 'desenvolvimento' | 'teste';

export interface Config {
  ambiente: Ambiente;
  porta: number;
  host: string;
  databaseUrl: string;

  /** Origem pública, usada em checagem de Origin e no cookie. */
  origemPublica: string;
  /** true quando a aplicação é servida por HTTPS (cookies Secure). */
  https: boolean;

  /** Segredo usado para derivar o "pepper" do hash de senha. */
  segredoSenha: string;

  sessao: {
    /** Validade absoluta da sessão. */
    duracaoMs: number;
    /** Inatividade máxima antes de exigir novo login. */
    inatividadeMs: number;
    nomeCookie: string;
    nomeCookieCsrf: string;
  };

  login: {
    /** Tentativas antes de bloquear a conta. */
    maxTentativas: number;
    /** Duração do bloqueio da conta. */
    bloqueioMs: number;
    /** Teto de requisições de login por IP na janela. */
    maxPorIp: number;
    janelaMs: number;
  };

  upload: {
    /** Tamanho máximo de um arquivo XLSX aceito na importação. */
    maxBytes: number;
    /** Tamanho máximo do corpo de requisições JSON. */
    maxJsonBytes: number;
  };

  /** Dias de retenção da auditoria. Ver LGPD.md. */
  retencaoAuditoriaDias: number;

  /** Confia no cabeçalho X-Forwarded-For (somente atrás de proxy próprio). */
  confiarProxy: boolean;
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

  // Provedores de hospedagem publicam a URL do serviço numa variável própria.
  // Aceitá-la evita que o usuário tenha de descobrir e digitar o endereço
  // durante a instalação — uma etapa a menos para errar.
  const origemPublica = (
    env.APP_URL || env.RENDER_EXTERNAL_URL || env.RAILWAY_PUBLIC_DOMAIN_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    'http://localhost:8080'
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
        'SECRET_KEY é obrigatória em produção. Gere uma com: openssl rand -base64 48\n' +
        'Trocar essa chave invalida TODAS as senhas existentes — guarde-a junto do backup.',
      );
    }
    segredoSenha = randomBytes(32).toString('base64');
  } else if (segredoSenha.length < 32) {
    throw new ErroConfig('SECRET_KEY deve ter no mínimo 32 caracteres.');
  }

  return {
    ambiente,
    porta: num('PORT', env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    origemPublica,
    https,
    segredoSenha,
    sessao: {
      duracaoMs: num('SESSION_MAX_HOURS', env.SESSION_MAX_HOURS, 12) * 3_600_000,
      inatividadeMs: num('SESSION_IDLE_MINUTES', env.SESSION_IDLE_MINUTES, 60) * 60_000,
      // O prefixo __Host- só é aceito pelo navegador junto com a flag Secure.
      // Como Secure depende de HTTPS, os nomes acompanham: com o prefixo em
      // produção (onde ele reforça a proteção contra cookie de subdomínio) e
      // sem ele em desenvolvimento HTTP, onde o cookie seria simplesmente
      // descartado. Trocar um pelo outro sem o par correspondente derruba o
      // login inteiro, de forma silenciosa.
      nomeCookie: https ? '__Host-sessao' : 'sessao',
      nomeCookieCsrf: https ? '__Host-csrf' : 'csrf',
    },
    login: {
      maxTentativas: num('LOGIN_MAX_TENTATIVAS', env.LOGIN_MAX_TENTATIVAS, 5),
      bloqueioMs: num('LOGIN_BLOQUEIO_MINUTOS', env.LOGIN_BLOQUEIO_MINUTOS, 15) * 60_000,
      maxPorIp: num('LOGIN_MAX_POR_IP', env.LOGIN_MAX_POR_IP, 20),
      janelaMs: num('LOGIN_JANELA_MINUTOS', env.LOGIN_JANELA_MINUTOS, 15) * 60_000,
    },
    upload: {
      maxBytes: num('UPLOAD_MAX_MB', env.UPLOAD_MAX_MB, 25) * 1_048_576,
      maxJsonBytes: num('JSON_MAX_KB', env.JSON_MAX_KB, 256) * 1024,
    },
    retencaoAuditoriaDias: num('RETENCAO_AUDITORIA_DIAS', env.RETENCAO_AUDITORIA_DIAS, 365),
    confiarProxy: bool(env.TRUST_PROXY, producao),
  };
}
