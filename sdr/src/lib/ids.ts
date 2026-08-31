/**
 * Identificadores ULID e tokens. Idêntico ao painel-comercial
 * (server/src/lib/ids.ts) — ver lá o raciocínio completo.
 */

import { randomBytes, randomInt } from 'node:crypto';

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

export function tokenOpaco(): string {
  return randomBytes(32).toString('base64url');
}

export function senhaProvisoria(): string {
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

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
