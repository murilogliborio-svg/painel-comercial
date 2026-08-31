/**
 * Sessões de servidor com token opaco. Idêntico ao painel-comercial
 * (server/src/auth/sessao.ts) — ver lá o raciocínio completo (token opaco
 * em vez de JWT, para permitir revogação real).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { ulid, tokenOpaco } from '../lib/ids.ts';

export interface Sessao {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  criado_em: string;
  expira_em: string;
  ultimo_uso: string;
  revogado_em: string | null;
}

export interface NovaSessao {
  token: string;
  csrf: string;
  sessaoId: string;
  expiraEm: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export interface OpcoesSessao {
  duracaoMs: number;
  inatividadeMs: number;
}

export async function criarSessao(
  db: Db,
  userId: string,
  opts: OpcoesSessao,
  meta: { ip: string | null; userAgent: string | null },
): Promise<NovaSessao> {
  const token = tokenOpaco();
  const csrf = randomBytes(32).toString('base64url');
  const agora = new Date();
  const expira = new Date(agora.getTime() + opts.duracaoMs);
  const id = ulid();

  await db.run(
    `INSERT INTO sessoes
       (id, user_id, token_hash, csrf_hash, criado_em, expira_em, ultimo_uso, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, hashToken(token), hashToken(csrf),
      agora.toISOString(), expira.toISOString(), agora.toISOString(),
      meta.ip, meta.userAgent?.slice(0, 300) ?? null,
    ],
  );

  return { token, csrf, sessaoId: id, expiraEm: expira.toISOString() };
}

export type MotivoInvalida = 'inexistente' | 'revogada' | 'expirada' | 'inativa';

export type ResultadoValidacao =
  | { ok: true; sessao: Sessao }
  | { ok: false; motivo: MotivoInvalida };

export async function validarSessao(
  db: Db,
  token: string,
  opts: OpcoesSessao,
  agora: Date = new Date(),
): Promise<ResultadoValidacao> {
  const s = await db.get<Sessao>('SELECT * FROM sessoes WHERE token_hash = ?', [hashToken(token)]);
  if (!s) return { ok: false, motivo: 'inexistente' };
  if (s.revogado_em) return { ok: false, motivo: 'revogada' };

  const ts = agora.getTime();
  if (ts >= Date.parse(s.expira_em)) return { ok: false, motivo: 'expirada' };
  if (ts - Date.parse(s.ultimo_uso) > opts.inatividadeMs) {
    await revogarSessao(db, s.id, 'inatividade');
    return { ok: false, motivo: 'inativa' };
  }

  if (ts - Date.parse(s.ultimo_uso) > 60_000) {
    await db.run('UPDATE sessoes SET ultimo_uso = ? WHERE id = ?', [agora.toISOString(), s.id]);
  }
  return { ok: true, sessao: s };
}

export function conferirCsrf(sessao: Sessao, enviado: string | null): boolean {
  if (!enviado) return false;
  const a = Buffer.from(hashToken(enviado));
  const b = Buffer.from(sessao.csrf_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function revogarSessao(db: Db, sessaoId: string, _motivo: string): Promise<void> {
  await db.run(
    'UPDATE sessoes SET revogado_em = ? WHERE id = ? AND revogado_em IS NULL',
    [new Date().toISOString(), sessaoId],
  );
}

export async function revogarTodasDoUsuario(db: Db, userId: string, exceto?: string): Promise<number> {
  const r = await db.run(
    `UPDATE sessoes SET revogado_em = ?
      WHERE user_id = ? AND revogado_em IS NULL AND id <> ?`,
    [new Date().toISOString(), userId, exceto ?? ''],
  );
  return r.changes;
}

export async function limparSessoes(db: Db, agora: Date = new Date()): Promise<number> {
  const corte = new Date(agora.getTime() - 7 * 86_400_000).toISOString();
  const r = await db.run(
    'DELETE FROM sessoes WHERE (revogado_em IS NOT NULL AND revogado_em < ?) OR expira_em < ?',
    [corte, corte],
  );
  return r.changes;
}
