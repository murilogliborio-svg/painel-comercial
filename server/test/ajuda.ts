/**
 * Utilidades de teste: sobe a aplicação inteira em memória, com a base real
 * importada, e devolve um cliente HTTP com sessão.
 */

import { readFileSync, existsSync } from 'node:fs';
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

/**
 * Diretório com as planilhas de exemplo. Se ausente, os testes que dependem
 * de dados reais são pulados em vez de falharem — a suíte precisa rodar em
 * qualquer clone do repositório.
 */
export const DIR_AMOSTRAS = process.env.AMOSTRAS_XLSX ?? join(AQUI, 'amostras');

export const ARQUIVOS_AMOSTRA = [
  'oportunidades.xlsx', 'acoes.xlsx', 'degustacoes.xlsx', 'vendas.xlsx',
];

export function temAmostras(): boolean {
  return ARQUIVOS_AMOSTRA.every((f) => existsSync(join(DIR_AMOSTRAS, f)));
}

export const SENHA_PADRAO = 'teste de senha longa 2026';

export interface Ambiente {
  db: Db;
  cfg: Config;
  servidor: Server;
  base: string;
  fechar(): Promise<void>;
  criarUsuario(o: {
    email: string; nome?: string; papel: Papel;
    consultorId?: string | null; podeEscrever?: boolean; ativo?: boolean;
  }): Promise<string>;
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

let portaSeq = 8500;

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
    maxJsonBytes: cfg.upload.maxJsonBytes,
    maxUploadBytes: cfg.upload.maxBytes,
    origemPublica: cfg.origemPublica,
  });
  await new Promise<void>((r) => servidor.listen(porta, '127.0.0.1', r));
  const base = `http://localhost:${porta}`;

  async function criarUsuario(o: {
    email: string; nome?: string; papel: Papel;
    consultorId?: string | null; podeEscrever?: boolean; ativo?: boolean;
  }): Promise<string> {
    const id = ulid();
    const agora = new Date().toISOString();
    await db.run(
      `INSERT INTO users (id, email, nome, papel, consultor_id, senha_hash, trocar_senha,
                          pode_escrever, ativo, criado_em, atualizado_em)
       VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
      [
        id, o.email, o.nome ?? o.email, o.papel, o.consultorId ?? null,
        await gerarHash(SENHA_PADRAO, cfg.segredoSenha),
        o.podeEscrever === false ? 0 : 1,
        o.ativo === false ? 0 : 1,
        agora, agora,
      ],
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
        if (corpo instanceof Buffer) {
          body = corpo;
          h['Content-Type'] = 'application/octet-stream';
        } else if (corpo !== undefined) {
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

/** Importa e confirma a base de amostra. Devolve o id da importação. */
export async function importarAmostras(_amb: Ambiente, cli: Cliente): Promise<string> {
  for (const nome of ARQUIVOS_AMOSTRA) {
    const bytes = readFileSync(join(DIR_AMOSTRAS, nome));
    const r = await cli.req('POST', '/api/importacao/arquivo', bytes, { 'X-Arquivo-Nome': nome });
    if (r.status !== 200) throw new Error(`upload de ${nome} falhou: ${JSON.stringify(r.corpo)}`);
  }
  const prep = await cli.req('POST', '/api/importacao/preparar', {});
  if (prep.status !== 200) throw new Error(`preparar falhou: ${JSON.stringify(prep.corpo)}`);
  const id = (prep.corpo as { importId: string }).importId;
  const conf = await cli.req('POST', `/api/importacao/${id}/confirmar`);
  if (conf.status !== 200) throw new Error(`confirmar falhou: ${JSON.stringify(conf.corpo)}`);
  return id;
}

/** Id do consultor pelo nome. */
export async function idConsultor(amb: Ambiente, nome: string): Promise<string> {
  const r = await amb.db.get<{ id: string }>('SELECT id FROM consultores WHERE nome = ?', [nome]);
  if (!r) throw new Error(`consultor "${nome}" não encontrado`);
  return r.id;
}
