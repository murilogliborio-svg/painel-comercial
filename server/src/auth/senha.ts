/**
 * Hash e verificação de senha.
 *
 * ALGORITMO
 * ---------
 * scrypt (RFC 7914), disponível nativamente no Node. Parâmetros N=2^16,
 * r=8, p=1, com custo de memória de ~64 MiB por verificação — dentro da
 * recomendação do OWASP para scrypt e proibitivo para ataque em GPU.
 *
 * Por que não Argon2id: seria a primeira escolha, mas exige dependência
 * nativa compilada. Para um sistema que precisa subir em qualquer servidor
 * sem toolchain de build, scrypt com parâmetros corretos é a opção
 * defensável — e é o que o próprio Node oferece com implementação auditada.
 * Se você já tem toolchain, trocar por argon2 é uma mudança localizada
 * neste arquivo: mantenha o formato `algo$params$salt$hash` e a função
 * `precisaRehash` cuidará da migração transparente no próximo login.
 *
 * DEFESA EM PROFUNDIDADE
 * ----------------------
 *   - Salt de 16 bytes por usuário, aleatório.
 *   - "Pepper" derivado de SECRET_KEY, que vive no ambiente e não no banco:
 *     um dump do banco sozinho não permite ataque de dicionário offline.
 *   - Comparação em tempo constante (timingSafeEqual).
 *   - `verificarDummy` mantém o custo de login constante para e-mail
 *     inexistente, impedindo enumeração de usuários por tempo de resposta.
 */

import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  senha: Buffer | string,
  salt: Buffer | string,
  chaves: number,
  opcoes: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 65536, r: 8, p: 1 } as const;
// maxmem precisa ser > 128 * N * r; damos folga de 2x.
const MAXMEM = 256 * PARAMS.N * PARAMS.r;
const TAM_HASH = 32;
const TAM_SALT = 16;

/** Aplica o pepper antes do KDF: HMAC-SHA256(SECRET_KEY, senha). */
function apimentar(senha: string, segredo: string): Buffer {
  return createHmac('sha256', segredo).update(senha, 'utf8').digest();
}

/** Gera o hash no formato `scrypt$N$r$p$saltB64$hashB64`. */
export async function gerarHash(senha: string, segredo: string): Promise<string> {
  const salt = randomBytes(TAM_SALT);
  const dk = await scryptAsync(apimentar(senha, segredo), salt, TAM_HASH, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    dk.toString('base64'),
  ].join('$');
}

/** Verifica a senha contra o hash armazenado. Nunca lança por hash malformado. */
export async function verificarHash(senha: string, armazenado: string, segredo: string): Promise<boolean> {
  const partes = armazenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const N = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Teto de sanidade: um hash adulterado com N gigante viraria negação de serviço.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let esperado: Buffer;
  try {
    salt = Buffer.from(partes[4]!, 'base64');
    esperado = Buffer.from(partes[5]!, 'base64');
  } catch {
    return false;
  }
  if (esperado.length !== TAM_HASH) return false;

  const obtido = await scryptAsync(apimentar(senha, segredo), salt, TAM_HASH, {
    N, r, p, maxmem: Math.max(MAXMEM, 256 * N * r),
  });
  return timingSafeEqual(obtido, esperado);
}

/**
 * Consome o mesmo custo de CPU de uma verificação real, para respostas de
 * login com e-mail inexistente. Sem isso, a diferença de tempo entre
 * "usuário não existe" (rápido) e "senha errada" (lento) permite enumerar
 * contas válidas.
 */
export async function verificarDummy(segredo: string): Promise<false> {
  await scryptAsync(apimentar('senha-inexistente', segredo), HASH_DUMMY_SALT, TAM_HASH, {
    ...PARAMS, maxmem: MAXMEM,
  });
  return false;
}
const HASH_DUMMY_SALT = Buffer.alloc(TAM_SALT, 7);

/** Indica que o hash foi gerado com parâmetros mais fracos que os atuais. */
export function precisaRehash(armazenado: string): boolean {
  const p = armazenado.split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return true;
  return Number(p[1]) < PARAMS.N || Number(p[2]) < PARAMS.r;
}

// ---------------------------------------------------------------------------
// Política de senha
// ---------------------------------------------------------------------------

/**
 * Baseada na NIST SP 800-63B: comprimento é o que importa; regras de
 * composição obrigatória levam a senhas piores e previsíveis ("Senha@123").
 * Aqui exigimos tamanho mínimo e bloqueamos as escolhas óbvias.
 */
const SENHAS_PROIBIDAS = new Set([
  'senha123456', '123456789012', 'querencia2026', 'grupoterra2026',
  'comercial2026', 'senhasenha12', 'aaaaaaaaaaaa', 'password1234',
]);

export interface ResultadoPolitica {
  ok: boolean;
  erros: string[];
}

export function validarPolitica(senha: string, contexto: string[] = []): ResultadoPolitica {
  const erros: string[] = [];

  if (senha.length < 12) erros.push('A senha precisa ter no mínimo 12 caracteres.');
  if (senha.length > 200) erros.push('A senha não pode passar de 200 caracteres.');
  if (/^\s|\s$/.test(senha)) erros.push('A senha não pode começar nem terminar com espaço.');

  const normal = senha.toLowerCase();
  if (SENHAS_PROIBIDAS.has(normal)) erros.push('Essa senha é previsível demais. Escolha outra.');

  if (/^(.)\1+$/.test(senha)) erros.push('A senha não pode ser um único caractere repetido.');

  // Sequências óbvias de teclado ou numéricas.
  if (/012345|123456|abcdef|qwerty|asdfgh/i.test(senha)) {
    erros.push('A senha contém uma sequência óbvia. Escolha outra.');
  }

  // Não pode conter o próprio nome ou e-mail. Comparamos com ambos os lados
  // reduzidos a letras e dígitos, senão "caroline.bortoleto@..." não pegaria
  // a senha "carolinebortoleto99", que é exatamente o caso a evitar.
  const so = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const senhaSo = so(senha);
  const tokens = new Set<string>();
  for (const c of contexto) {
    const local = c.split('@')[0]!;
    for (const t of local.split(/[^A-Za-zÀ-ÿ0-9]+/)) {
      const n = so(t);
      if (n.length >= 4) tokens.add(n);
    }
    const inteiroTok = so(local);
    if (inteiroTok.length >= 4) tokens.add(inteiroTok);
  }
  for (const t of tokens) {
    if (senhaSo.includes(t)) {
      erros.push('A senha não pode conter seu nome ou e-mail.');
      break;
    }
  }

  return { ok: erros.length === 0, erros };
}
