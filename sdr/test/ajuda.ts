/**
 * Utilidades de teste: sobe a aplicação inteira em memória e devolve um
 * cliente HTTP com sessão. Mesmo desenho do painel-comercial (test/ajuda.ts).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';

import { carregarConfig, type Config } from '../src/config.ts';
import { connect, migrate, type Db } from '../src/db/index.ts';
import { criarServidor } from '../src/http/servidor.ts';
import { montarApp } from '../src/app.ts';
import { gerarHash } from '../src/auth/senha.ts';
import { ulid } from '../src/lib/ids.ts';
import type { Papel } from '../src/auth/contexto.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));

export const SENHA_PADRAO = 'teste de senha longa 2026';

export interface Ambiente {
  db: Db;
  cfg: Config;
  servidor: Server;
  base: string;
  fechar(): Promise<void>;
  criarUsuario(o: { email: string; nome?: string; papel: Papel; ativo?: boolean }): Promise<string>;
  cliente(): Cliente;
}

export interface RespostaTeste {
  status: number;
  corpo: any;
  cabecalhos: Headers;
}

export interface Cliente {
  cookies: string;
  csrf: string;
  login(email: string, senha?: string): Promise<RespostaTeste>;
  req(metodo: string, caminho: string, corpo?: unknown, extras?: Record<string, string>): Promise<RespostaTeste>;
}

let portaSeq = 8700;

export async function subirAmbiente(): Promise<Ambiente> {
  const porta = portaSeq++;
  const cfg = carregarConfig({
    NODE_ENV: 'teste',
    DATABASE_URL: 'sqlite::memory:',
    SECRET_KEY: 'chave-de-teste-com-mais-de-32-caracteres-ok',
    APP_URL: `http://localhost:${porta}`,
    PORT: String(porta),
  } as NodeJS.ProcessEnv);

  const db = await connect(cfg.databaseUrl);
  await migrate(db);

  const { roteador } = montarApp(db, cfg, join(AQUI, '..', 'web'));
  const servidor = criarServidor({
    roteador,
    https: false,
    confiarProxy: false,
    maxJsonBytes: cfg.maxJsonBytes,
    maxUploadBytes: cfg.maxJsonBytes,
    origemPublica: cfg.origemPublica,
  });
  await new Promise<void>((r) => servidor.listen(porta, '127.0.0.1', r));
  const base = `http://localhost:${porta}`;

  async function criarUsuario(o: { email: string; nome?: string; papel: Papel; ativo?: boolean }): Promise<string> {
    const id = ulid();
    const agora = new Date().toISOString();
    await db.run(
      `INSERT INTO users (id, email, nome, papel, senha_hash, trocar_senha, ativo, criado_em, atualizado_em)
       VALUES (?,?,?,?,?,0,?,?,?)`,
      [id, o.email, o.nome ?? o.email, o.papel, await gerarHash(SENHA_PADRAO, cfg.segredoSenha),
       o.ativo === false ? 0 : 1, agora, agora],
    );
    return id;
  }

  function cliente(): Cliente {
    const c: Cliente = {
      cookies: '',
      csrf: '',
      async req(metodo, caminho, corpo, extras = {}) {
        const h: Record<string, string> = { Origin: base, ...extras };
        if (c.cookies) h['Cookie'] = c.cookies;
        if (c.csrf) h['X-CSRF-Token'] = c.csrf;
        let body: Buffer | string | undefined;
        if (corpo !== undefined) {
          body = JSON.stringify(corpo);
          h['Content-Type'] = 'application/json';
        }
        const r = await fetch(base + caminho, { method: metodo, headers: h, body });
        const sc = r.headers.getSetCookie?.() ?? [];
        if (sc.length) c.cookies = sc.map((x) => x.split(';')[0]).join('; ');
        const txt = await r.text();
        let parsed: unknown = txt;
        try { parsed = JSON.parse(txt); } catch { /* resposta não-JSON */ }
        return { status: r.status, corpo: parsed, cabecalhos: r.headers };
      },
      async login(email, senha = SENHA_PADRAO) {
        const r = await c.req('POST', '/api/auth/login', { email, senha });
        if (r.status === 200) c.csrf = (r.corpo as { csrf: string }).csrf;
        return r;
      },
    };
    return c;
  }

  return {
    db, cfg, servidor, base, criarUsuario, cliente,
    async fechar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await db.close();
    },
  };
}
