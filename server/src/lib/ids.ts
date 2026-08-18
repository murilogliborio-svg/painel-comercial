/**
 * Identificadores ULID (Universally Unique Lexicographically Sortable ID).
 *
 * Escolhidos no lugar de UUIDv4 e de autoincremento porque:
 *   - São ordenáveis por tempo de criação, o que torna `ORDER BY id` útil e
 *     mantém o índice B-tree denso (UUIDv4 fragmenta o índice).
 *   - Não revelam contagem de registros, ao contrário do autoincremento
 *     (um id 47 numa URL diz ao usuário quantos registros existem).
 *   - São gerados na aplicação, então funcionam igual em SQLite e Postgres.
 */

import { randomBytes, randomInt } from 'node:crypto';

// Alfabeto Crockford base32: sem I, L, O e U, para não confundir na leitura.
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let ultimoMs = -1;
let ultimaAleatoria: number[] = [];

function codificaTempo(ms: number): string {
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = ALFABETO[ms % 32]! + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function codificaAleatorio(bytes: number[]): string {
  return bytes.map((b) => ALFABETO[b % 32]!).join('');
}

/**
 * Gera um ULID de 26 caracteres. Dentro do mesmo milissegundo, incrementa a
 * parte aleatória em vez de sorteá-la de novo, garantindo monotonicidade
 * (dois ids criados no mesmo ms mantêm a ordem de criação).
 */
export function ulid(agora: number = Date.now()): string {
  if (agora === ultimoMs) {
    for (let i = ultimaAleatoria.length - 1; i >= 0; i--) {
      if (ultimaAleatoria[i]! < 31) { ultimaAleatoria[i]!++; break; }
      ultimaAleatoria[i] = 0;
    }
  } else {
    ultimoMs = agora;
    ultimaAleatoria = Array.from(randomBytes(16)).map((b) => b % 32);
  }
  return codificaTempo(agora) + codificaAleatorio(ultimaAleatoria);
}

/** Token opaco de sessão: 256 bits em base64url. Nunca é gravado em claro. */
export function tokenOpaco(): string {
  return randomBytes(32).toString('base64url');
}

/** Senha inicial legível, para entrega ao colaborador na criação da conta. */
export function senhaProvisoria(): string {
  // Sem caracteres ambíguos: quem digita a senha lida em papel não erra.
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const maiusc = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const nums = '23456789';
  const simb = '!@#$%&*+=?';
  const todos = letras + maiusc + nums + simb;

  const chars = [
    letras[randomInt(letras.length)]!,
    maiusc[randomInt(maiusc.length)]!,
    nums[randomInt(nums.length)]!,
    simb[randomInt(simb.length)]!,
  ];
  while (chars.length < 14) chars.push(todos[randomInt(todos.length)]!);

  // Fisher-Yates com fonte criptográfica.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
