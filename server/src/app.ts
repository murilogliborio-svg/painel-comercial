/**
 * Montagem da aplicação: middlewares, rotas e arquivos estáticos.
 * Exportada como função para que os testes subam a app inteira em memória.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { createHash } from 'node:crypto';

import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import {
  Roteador, erro, type Requisicao, type Resposta, type CookieDef,
} from './http/servidor.ts';
import { LimitadorTaxa } from './http/limite.ts';
import { criarAuditor, type Auditor } from './lib/auditoria.ts';
import { ulid, senhaProvisoria } from './lib/ids.ts';
import {
  gerarHash, verificarHash, verificarDummy, precisaRehash, validarPolitica,
} from './auth/senha.ts';
import {
  criarSessao, validarSessao, conferirCsrf, revogarSessao, revogarTodasDoUsuario,
} from './auth/sessao.ts';
import {
  exigirAuth, exigirPapel, exigirEscrita, escopoConsultor, carregarUsuario,
  type Autenticado, type Papel,
} from './auth/contexto.ts';
import {
  resumoPorConsultor, totaisGerais, motivosPerda, listaNominal,
  oportunidadePertence, type TipoLista,
} from './domain/consultas.ts';
import {
  prepararImportacao, confirmarImportacao, reverterImportacao, descartarImportacao,
  importacaoAtiva, type ArquivoEnviado,
} from './domain/importar.ts';
import { ErroEtl } from './domain/etl.ts';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface Aplicacao {
  roteador: Roteador;
  auditor: Auditor;
}

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

function corpo(req: Requisicao): Record<string, unknown> {
  return (req.corpo ?? {}) as Record<string, unknown>;
}

function str(v: unknown, campo: string, opts: { max?: number; min?: number; obrigatorio?: boolean } = {}): string {
  const { max = 500, min = 1, obrigatorio = true } = opts;
  if (v === undefined || v === null || v === '') {
    if (obrigatorio) throw erro.requisicao(`Campo "${campo}" é obrigatório.`);
    return '';
  }
  if (typeof v !== 'string') throw erro.requisicao(`Campo "${campo}" deve ser texto.`);
  const s = v.trim();
  if (s.length < min) throw erro.requisicao(`Campo "${campo}" deve ter ao menos ${min} caractere(s).`);
  if (s.length > max) throw erro.requisicao(`Campo "${campo}" excede ${max} caracteres.`);
  return s;
}

function umDe<T extends string>(v: unknown, campo: string, opcoes: readonly T[]): T {
  const s = str(v, campo);
  if (!opcoes.includes(s as T)) {
    throw erro.requisicao(`Campo "${campo}" deve ser um de: ${opcoes.join(', ')}.`);
  }
  return s as T;
}

function emailValido(v: unknown): string {
  const s = str(v, 'email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw erro.requisicao('E-mail inválido.');
  return s;
}

// ---------------------------------------------------------------------------
// Área de espera de upload (memória, por sessão)
// ---------------------------------------------------------------------------

interface Pendente { arquivos: ArquivoEnviado[]; em: number }
const TTL_PENDENTE_MS = 30 * 60_000;

class AreaUpload {
  #mapa = new Map<string, Pendente>();

  adicionar(sessaoId: string, arq: ArquivoEnviado, maxArquivos = 8): number {
    this.#expirar();
    const p = this.#mapa.get(sessaoId) ?? { arquivos: [], em: Date.now() };
    if (p.arquivos.length >= maxArquivos) {
      throw erro.requisicao(`Máximo de ${maxArquivos} arquivos por importação.`);
    }
    p.arquivos = p.arquivos.filter((a) => a.nome !== arq.nome);
    p.arquivos.push(arq);
    p.em = Date.now();
    this.#mapa.set(sessaoId, p);
    return p.arquivos.length;
  }

  listar(sessaoId: string): ArquivoEnviado[] {
    this.#expirar();
    return this.#mapa.get(sessaoId)?.arquivos ?? [];
  }

  limpar(sessaoId: string): void { this.#mapa.delete(sessaoId); }

  #expirar(): void {
    const corte = Date.now() - TTL_PENDENTE_MS;
    for (const [k, v] of this.#mapa) if (v.em < corte) this.#mapa.delete(k);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function montarApp(db: Db, cfg: Config, dirWeb: string): Aplicacao {
  const r = new Roteador();
  const auditor = criarAuditor(db, (e) => console.error('[auditoria] falha ao gravar:', e));
  const area = new AreaUpload();

  const limitePorIp = new LimitadorTaxa(cfg.login.maxPorIp, cfg.login.janelaMs, cfg.login.janelaMs);
  const limiteApi = new LimitadorTaxa(600, 60_000);
  const limiteEscrita = new LimitadorTaxa(120, 60_000);

  const cookieSessao = (valor: string, maxAge?: number): CookieDef => ({
    nome: cfg.sessao.nomeCookie, valor, httpOnly: true, secure: cfg.https,
    sameSite: 'Strict', caminho: '/', maxAgeSegundos: maxAge,
  });
  const cookieCsrf = (valor: string, maxAge?: number): CookieDef => ({
    // Legível por JavaScript de propósito: o frontend precisa ecoá-lo no
    // cabeçalho. O padrão é "double submit" — o atacante em outro domínio
    // consegue enviar o cookie, mas não consegue LER para montar o cabeçalho.
    nome: cfg.sessao.nomeCookieCsrf, valor, httpOnly: false, secure: cfg.https,
    sameSite: 'Strict', caminho: '/', maxAgeSegundos: maxAge,
  });
  const cookiesLimpos = (): CookieDef[] => [
    { ...cookieSessao(''), expiraJa: true },
    { ...cookieCsrf(''), expiraJa: true },
  ];

  // -------------------------------------------------------------------------
  // Middleware: sessão, CSRF, origem, limite
  // -------------------------------------------------------------------------

  r.usar(async (req) => {
    const api = req.caminho.startsWith('/api/');

    if (api) {
      const l = METODOS_SEGUROS.has(req.metodo)
        ? limiteApi.verificar(req.ip)
        : limiteEscrita.verificar(req.ip);
      if (!l.permitido) throw erro.excesso();
    }

    // Origem: barreira adicional de CSRF que não depende de JavaScript.
    if (api && !METODOS_SEGUROS.has(req.metodo)) {
      const origem = (req.cabecalhos['origin'] as string | undefined)
        ?? (req.cabecalhos['referer'] as string | undefined);
      if (origem) {
        let ok = false;
        try { ok = new URL(origem).origin === new URL(cfg.origemPublica).origin; } catch { ok = false; }
        if (!ok) throw erro.proibido('Origem da requisição não autorizada.');
      } else if (cfg.ambiente === 'producao') {
        throw erro.proibido('Requisição sem cabeçalho Origin foi recusada.');
      }
    }

    const token = req.cookies[cfg.sessao.nomeCookie];
    if (!token) return;

    const v = await validarSessao(db, token, cfg.sessao);
    if (!v.ok) {
      req.ctx['sessaoInvalida'] = v.motivo;
      return;
    }

    const usuario = await carregarUsuario(db, v.sessao.user_id);
    if (!usuario) {
      await revogarSessao(db, v.sessao.id, 'usuario_inativo');
      req.ctx['sessaoInvalida'] = 'revogada';
      return;
    }

    // CSRF só para métodos que alteram estado.
    if (api && !METODOS_SEGUROS.has(req.metodo)) {
      const enviado = (req.cabecalhos['x-csrf-token'] as string | undefined) ?? null;
      if (!conferirCsrf(v.sessao, enviado)) {
        await auditor({
          acao: 'acesso.negado', userId: usuario.id, email: usuario.email,
          sucesso: false, ip: req.ip, userAgent: req.userAgent,
          detalhe: { motivo: 'csrf', caminho: req.caminho },
        });
        throw erro.proibido('Token CSRF ausente ou inválido. Recarregue a página e tente de novo.');
      }
    }

    req.ctx['auth'] = { usuario, sessaoId: v.sessao.id } satisfies Autenticado;
  });

  /** Base ativa; sem ela o painel não tem o que mostrar. */
  async function exigirBase(): Promise<string> {
    const id = await importacaoAtiva(db);
    if (!id) {
      throw erro.naoEncontrado(
        'Nenhuma base de dados ativa. O gestor precisa importar as planilhas do CRM primeiro.',
      );
    }
    return id;
  }

  const agora = () => new Date().toISOString();

  // -------------------------------------------------------------------------
  // Autenticação
  // -------------------------------------------------------------------------

  r.post('/api/auth/login', async (req): Promise<Resposta> => {
    const c = corpo(req);
    const email = emailValido(c['email']);
    const senha = str(c['senha'], 'senha', { max: 200 });

    const lim = limitePorIp.verificar(`login:${req.ip}`);
    if (!lim.permitido) {
      await auditor({ acao: 'login.bloqueado', email, sucesso: false, ip: req.ip,
        userAgent: req.userAgent, detalhe: { motivo: 'limite_ip' } });
      throw erro.excesso(`Tentativas demais deste endereço. Aguarde ${Math.ceil(lim.esperarMs / 60000)} minuto(s).`);
    }

    const u = await db.get<{
      id: string; email: string; nome: string; papel: Papel; senha_hash: string;
      ativo: number; falhas: number; bloqueado_ate: string | null; trocar_senha: number;
    }>('SELECT * FROM users WHERE email = ?', [email]);

    // Mensagem única para usuário inexistente, senha errada e conta inativa:
    // qualquer diferenciação vira ferramenta de enumeração de contas.
    const generico = 'E-mail ou senha incorretos.';

    if (!u || !u.ativo) {
      await verificarDummy(cfg.segredoSenha);
      await auditor({ acao: 'login.falha', email, sucesso: false, ip: req.ip,
        userAgent: req.userAgent, detalhe: { motivo: u ? 'inativo' : 'inexistente' } });
      throw new (await import('./http/servidor.ts')).ErroHttp(401, generico, 'credenciais');
    }

    if (u.bloqueado_ate && Date.parse(u.bloqueado_ate) > Date.now()) {
      await verificarDummy(cfg.segredoSenha);
      await auditor({ acao: 'login.bloqueado', userId: u.id, email, sucesso: false,
        ip: req.ip, userAgent: req.userAgent });
      const faltam = Math.ceil((Date.parse(u.bloqueado_ate) - Date.now()) / 60000);
      throw erro.excesso(`Conta temporariamente bloqueada por tentativas seguidas. Tente em ${faltam} minuto(s).`);
    }

    const ok = await verificarHash(senha, u.senha_hash, cfg.segredoSenha);
    if (!ok) {
      const falhas = u.falhas + 1;
      const bloquear = falhas >= cfg.login.maxTentativas;
      await db.run(
        'UPDATE users SET falhas = ?, bloqueado_ate = ?, atualizado_em = ? WHERE id = ?',
        [
          bloquear ? 0 : falhas,
          bloquear ? new Date(Date.now() + cfg.login.bloqueioMs).toISOString() : null,
          agora(), u.id,
        ],
      );
      await auditor({ acao: 'login.falha', userId: u.id, email, sucesso: false, ip: req.ip,
        userAgent: req.userAgent, detalhe: { tentativa: falhas, bloqueou: bloquear } });
      throw new (await import('./http/servidor.ts')).ErroHttp(401, generico, 'credenciais');
    }

    // Rehash transparente se os parâmetros do KDF ficaram para trás.
    if (precisaRehash(u.senha_hash)) {
      await db.run('UPDATE users SET senha_hash = ? WHERE id = ?', [
        await gerarHash(senha, cfg.segredoSenha), u.id,
      ]);
    }

    await db.run(
      'UPDATE users SET falhas = 0, bloqueado_ate = NULL, ultimo_login = ?, atualizado_em = ? WHERE id = ?',
      [agora(), agora(), u.id],
    );
    limitePorIp.liberar(`login:${req.ip}`);

    const s = await criarSessao(db, u.id, cfg.sessao, { ip: req.ip, userAgent: req.userAgent });
    await auditor({ acao: 'login.sucesso', userId: u.id, email, ip: req.ip, userAgent: req.userAgent });

    const maxAge = Math.floor(cfg.sessao.duracaoMs / 1000);
    const usuario = await carregarUsuario(db, u.id);
    return {
      status: 200,
      corpo: { usuario: publico(usuario!), csrf: s.csrf, expiraEm: s.expiraEm },
      cookies: [cookieSessao(s.token, maxAge), cookieCsrf(s.csrf, maxAge)],
    };
  });

  r.post('/api/auth/logout', async (req): Promise<Resposta> => {
    const a = req.ctx['auth'] as Autenticado | undefined;
    if (a) {
      await revogarSessao(db, a.sessaoId, 'logout');
      await auditor({ acao: 'logout', userId: a.usuario.id, email: a.usuario.email,
        ip: req.ip, userAgent: req.userAgent });
    }
    return { status: 200, corpo: { ok: true }, cookies: cookiesLimpos() };
  });

  r.get('/api/auth/eu', async (req): Promise<Resposta> => {
    const a = req.ctx['auth'] as Autenticado | undefined;
    if (!a) {
      return {
        status: 401,
        corpo: { erro: 'nao_autenticado', motivo: req.ctx['sessaoInvalida'] ?? 'ausente' },
        cookies: req.ctx['sessaoInvalida'] ? cookiesLimpos() : undefined,
      };
    }
    const baseId = await importacaoAtiva(db);
    const base = baseId
      ? await db.get<{ periodo_ini: string; periodo_fim: string; confirmado_em: string }>(
          'SELECT periodo_ini, periodo_fim, confirmado_em FROM importacoes WHERE id = ?', [baseId])
      : null;
    // O token CSRF volta aqui além do cookie: o frontend não precisa
    // depender do nome do cookie, e o token continua preso à sessão no
    // servidor (tabela sessoes.csrf_hash). Outra origem não consegue ler
    // esta resposta, então devolvê-la não enfraquece a proteção.
    const s = await db.get<{ csrf_hash: string }>('SELECT csrf_hash FROM sessoes WHERE id = ?', [a.sessaoId]);
    return {
      status: 200,
      corpo: { usuario: publico(a.usuario), base, csrfAtivo: !!s },
    };
  });

  r.post('/api/auth/senha', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const c = corpo(req);
    const atual = str(c['atual'], 'atual', { max: 200 });
    const nova = str(c['nova'], 'nova', { max: 200 });

    const u = await db.get<{ senha_hash: string }>('SELECT senha_hash FROM users WHERE id = ?', [a.usuario.id]);
    if (!u || !(await verificarHash(atual, u.senha_hash, cfg.segredoSenha))) {
      await auditor({ acao: 'senha.alterada', userId: a.usuario.id, email: a.usuario.email,
        sucesso: false, ip: req.ip, userAgent: req.userAgent });
      throw erro.requisicao('A senha atual está incorreta.');
    }
    if (nova === atual) throw erro.requisicao('A nova senha precisa ser diferente da atual.');

    const pol = validarPolitica(nova, [a.usuario.email, a.usuario.nome]);
    if (!pol.ok) throw erro.requisicao(pol.erros[0]!, { erros: pol.erros });

    await db.run(
      'UPDATE users SET senha_hash = ?, trocar_senha = 0, senha_alterada_em = ?, atualizado_em = ? WHERE id = ?',
      [await gerarHash(nova, cfg.segredoSenha), agora(), agora(), a.usuario.id],
    );
    // Encerra as outras sessões: se a troca foi por suspeita de vazamento,
    // manter as demais abertas anularia o efeito.
    const encerradas = await revogarTodasDoUsuario(db, a.usuario.id, a.sessaoId);
    await auditor({ acao: 'senha.alterada', userId: a.usuario.id, email: a.usuario.email,
      ip: req.ip, userAgent: req.userAgent, detalhe: { sessoesEncerradas: encerradas } });

    return { status: 200, corpo: { ok: true, sessoesEncerradas: encerradas } };
  });

  // -------------------------------------------------------------------------
  // Painel
  // -------------------------------------------------------------------------

  r.get('/api/painel/resumo', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const importId = await exigirBase();
    const alvo = escopoConsultor(req, req.query.get('consultor'));
    const [totais, motivos] = await Promise.all([
      totaisGerais(db, importId, agora(), alvo),
      motivosPerda(db, importId, alvo),
    ]);
    return { status: 200, corpo: { totais, motivos, escopo: alvo } };
  });

  r.get('/api/painel/consultores', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const importId = await exigirBase();
    const alvo = escopoConsultor(req, req.query.get('consultor'));
    const linhas = await resumoPorConsultor(db, importId, agora(), alvo);

    // Consultor recebe também os agregados do time (média, melhor, posição),
    // que são estatística, não dado pessoal de terceiro.
    let referencia = null;
    if (alvo) {
      const todos = await resumoPorConsultor(db, importId, agora(), null);
      referencia = agregarReferencia(todos, alvo);
    }
    return { status: 200, corpo: { consultores: linhas, referencia } };
  });

  r.get('/api/listas/:tipo', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const importId = await exigirBase();
    const tipo = umDe<TipoLista>(req.params['tipo'], 'tipo', [
      'vencidas', 'aguardando', 'sem_sucesso', 'perdidos', 'degustacoes', 'contratos',
    ]);
    const alvo = escopoConsultor(req, req.query.get('consultor'));
    const limite = Number(req.query.get('limite') ?? 500);
    const itens = await listaNominal(db, importId, tipo, agora(), alvo, limite);

    // Acesso a lista nominal é dado pessoal de cliente: sempre auditado.
    await auditor({
      acao: 'lista.consultada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'lista', entidadeId: tipo, ip: req.ip, userAgent: req.userAgent,
      detalhe: { escopo: alvo, retornados: itens.length },
    });
    return { status: 200, corpo: { tipo, itens } };
  });

  // -------------------------------------------------------------------------
  // Trabalho do consultor
  // -------------------------------------------------------------------------

  /** Consultor só escreve no que é dele; gestor precisa dizer de quem é. */
  async function consultorAlvo(req: Requisicao, importId: string, num: string): Promise<string> {
    const a = exigirAuth(req);
    if (a.usuario.papel === 'consultor') {
      const id = escopoConsultor(req)!;
      if (!(await oportunidadePertence(db, importId, num, id))) {
        throw erro.proibido('Esta oportunidade não está na sua carteira.');
      }
      return id;
    }
    const informado = str(corpo(req)['consultor_id'], 'consultor_id', { max: 40 });
    return informado;
  }

  r.post('/api/trabalho/tratativa', async (req): Promise<Resposta> => {
    const a = exigirEscrita(req);
    const importId = await exigirBase();
    const c = corpo(req);
    const num = str(c['num_oportunidade'], 'num_oportunidade', { max: 40 });
    const chave = str(c['chave_acao'], 'chave_acao', { max: 80 });
    const resultado = umDe(c['resultado'], 'resultado', [
      'contato_feito', 'reagendado', 'sem_resposta', 'nao_se_aplica', 'concluido',
    ]);
    const obs = str(c['observacao'], 'observacao', { max: 2000, obrigatorio: false });
    const alvo = await consultorAlvo(req, importId, num);

    const existente = await db.get<{ id: string }>(
      'SELECT id FROM tratativas WHERE num_oportunidade = ? AND chave_acao = ? AND consultor_id = ?',
      [num, chave, alvo],
    );
    if (existente) {
      await db.run(
        'UPDATE tratativas SET resultado = ?, observacao = ?, tratado_em = ?, user_id = ? WHERE id = ?',
        [resultado, obs || null, agora(), a.usuario.id, existente.id],
      );
    } else {
      await db.run(
        `INSERT INTO tratativas (id, num_oportunidade, chave_acao, consultor_id, user_id, resultado, observacao, tratado_em)
         VALUES (?,?,?,?,?,?,?,?)`,
        [ulid(), num, chave, alvo, a.usuario.id, resultado, obs || null, agora()],
      );
    }
    await auditor({ acao: 'tratativa.registrada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'oportunidade', entidadeId: num, ip: req.ip, userAgent: req.userAgent,
      detalhe: { resultado, consultor: alvo } });
    return { status: 200, corpo: { ok: true } };
  });

  r.delete('/api/trabalho/tratativa', async (req): Promise<Resposta> => {
    const a = exigirEscrita(req);
    const importId = await exigirBase();
    const c = corpo(req);
    const num = str(c['num_oportunidade'], 'num_oportunidade', { max: 40 });
    const chave = str(c['chave_acao'], 'chave_acao', { max: 80 });
    const alvo = await consultorAlvo(req, importId, num);
    const rr = await db.run(
      'DELETE FROM tratativas WHERE num_oportunidade = ? AND chave_acao = ? AND consultor_id = ?',
      [num, chave, alvo],
    );
    await auditor({ acao: 'tratativa.registrada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'oportunidade', entidadeId: num, ip: req.ip, userAgent: req.userAgent,
      detalhe: { desfeita: true } });
    return { status: 200, corpo: { ok: true, removidas: rr.changes } };
  });

  r.get('/api/trabalho/notas/:num', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const importId = await exigirBase();
    const num = str(req.params['num'], 'num', { max: 40 });
    if (a.usuario.papel === 'consultor') {
      const id = escopoConsultor(req)!;
      if (!(await oportunidadePertence(db, importId, num, id))) {
        throw erro.proibido('Esta oportunidade não está na sua carteira.');
      }
    }
    const notas = await db.all(
      `SELECT n.id, n.texto, n.criado_em, u.nome AS autor
         FROM notas n JOIN users u ON u.id = n.autor_id
        WHERE n.num_oportunidade = ? AND n.removido_em IS NULL
        ORDER BY n.criado_em DESC LIMIT 200`,
      [num],
    );
    return { status: 200, corpo: { notas } };
  });

  r.post('/api/trabalho/notas', async (req): Promise<Resposta> => {
    const a = exigirEscrita(req);
    const importId = await exigirBase();
    const c = corpo(req);
    const num = str(c['num_oportunidade'], 'num_oportunidade', { max: 40 });
    const texto = str(c['texto'], 'texto', { max: 4000 });
    const alvo = await consultorAlvo(req, importId, num);

    const id = ulid();
    await db.run(
      'INSERT INTO notas (id, num_oportunidade, consultor_id, autor_id, texto, criado_em) VALUES (?,?,?,?,?,?)',
      [id, num, alvo, a.usuario.id, texto, agora()],
    );
    await auditor({ acao: 'nota.criada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'oportunidade', entidadeId: num, ip: req.ip, userAgent: req.userAgent });
    return { status: 201, corpo: { id } };
  });

  r.delete('/api/trabalho/notas/:id', async (req): Promise<Resposta> => {
    const a = exigirEscrita(req);
    const id = str(req.params['id'], 'id', { max: 40 });
    const n = await db.get<{ autor_id: string; num_oportunidade: string }>(
      'SELECT autor_id, num_oportunidade FROM notas WHERE id = ? AND removido_em IS NULL', [id],
    );
    if (!n) throw erro.naoEncontrado('Nota não encontrada.');
    if (n.autor_id !== a.usuario.id && a.usuario.papel === 'consultor') {
      throw erro.proibido('Você só pode remover as suas próprias notas.');
    }
    // Remoção lógica: a auditoria precisa poder mostrar que existiu.
    await db.run('UPDATE notas SET removido_em = ? WHERE id = ?', [agora(), id]);
    await auditor({ acao: 'nota.removida', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'nota', entidadeId: id, ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true } };
  });

  // -------------------------------------------------------------------------
  // Metas
  // -------------------------------------------------------------------------

  r.get('/api/metas', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const alvo = escopoConsultor(req, req.query.get('consultor'));
    const f = alvo ? ' WHERE m.consultor_id = ?' : '';
    const metas = await db.all(
      `SELECT m.id, m.consultor_id, c.nome AS consultor, m.periodo_ini, m.periodo_fim,
              m.metrica, m.alvo, m.observacao
         FROM metas m JOIN consultores c ON c.id = m.consultor_id${f}
        ORDER BY m.periodo_ini DESC, c.nome ASC LIMIT 500`,
      alvo ? [alvo] : [],
    );
    return { status: 200, corpo: { metas } };
  });

  r.post('/api/metas', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const c = corpo(req);
    const consultorId = str(c['consultor_id'], 'consultor_id', { max: 40 });
    const metrica = umDe(c['metrica'], 'metrica', [
      'faturamento', 'contratos', 'degustacoes', 'conversao', 'acoes',
    ]);
    const alvo = Number(c['alvo']);
    if (!Number.isFinite(alvo) || alvo < 0) throw erro.requisicao('Campo "alvo" deve ser um número não negativo.');
    const ini = str(c['periodo_ini'], 'periodo_ini', { max: 30 });
    const fim = str(c['periodo_fim'], 'periodo_fim', { max: 30 });
    if (Date.parse(ini) > Date.parse(fim)) throw erro.requisicao('O início do período é posterior ao fim.');
    const obs = str(c['observacao'], 'observacao', { max: 500, obrigatorio: false });

    const existe = await db.get<{ id: string }>(
      `SELECT id FROM metas WHERE consultor_id = ? AND periodo_ini = ? AND periodo_fim = ? AND metrica = ?`,
      [consultorId, ini, fim, metrica],
    );
    if (existe) {
      await db.run('UPDATE metas SET alvo = ?, observacao = ?, criado_por = ?, criado_em = ? WHERE id = ?',
        [alvo, obs || null, a.usuario.id, agora(), existe.id]);
    } else {
      await db.run(
        `INSERT INTO metas (id, consultor_id, periodo_ini, periodo_fim, metrica, alvo, observacao, criado_por, criado_em)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [ulid(), consultorId, ini, fim, metrica, alvo, obs || null, a.usuario.id, agora()],
      );
    }
    await auditor({ acao: 'meta.definida', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'consultor', entidadeId: consultorId, ip: req.ip, userAgent: req.userAgent,
      detalhe: { metrica, alvo } });
    return { status: 200, corpo: { ok: true } };
  });

  r.delete('/api/metas/:id', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    const rr = await db.run('DELETE FROM metas WHERE id = ?', [id]);
    if (rr.changes === 0) throw erro.naoEncontrado('Meta não encontrada.');
    await auditor({ acao: 'meta.removida', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'meta', entidadeId: id, ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true } };
  });

  // -------------------------------------------------------------------------
  // Importação
  // -------------------------------------------------------------------------

  r.post('/api/importacao/arquivo', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    if (!req.binario || req.binario.length === 0) {
      throw erro.requisicao('Envie o arquivo no corpo da requisição como application/octet-stream.');
    }
    const nome = str(req.cabecalhos['x-arquivo-nome'], 'X-Arquivo-Nome', { max: 200 });
    if (!/\.xlsx$/i.test(nome)) throw erro.requisicao('Apenas arquivos .xlsx são aceitos.');
    // Assinatura de ZIP ("PK\x03\x04"): recusa cedo o que não é planilha.
    if (req.binario.subarray(0, 4).toString('hex') !== '504b0304') {
      throw erro.requisicao('O arquivo não é um .xlsx válido.');
    }
    const total = area.adicionar(a.sessaoId, { nome, bytes: req.binario });
    return { status: 200, corpo: { recebido: nome, bytes: req.binario.length, naFila: total } };
  });

  r.post('/api/importacao/preparar', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const arquivos = area.listar(a.sessaoId);
    if (arquivos.length === 0) throw erro.requisicao('Nenhum arquivo enviado nesta sessão.');
    const obs = str(corpo(req)['observacao'], 'observacao', { max: 500, obrigatorio: false });

    try {
      const res = await prepararImportacao(db, arquivos, a.usuario.id, obs || null);
      area.limpar(a.sessaoId);
      await auditor({ acao: 'importacao.enviada', userId: a.usuario.id, email: a.usuario.email,
        entidade: 'importacao', entidadeId: res.importId, ip: req.ip, userAgent: req.userAgent,
        detalhe: { estatisticas: res.estatisticas } });
      return { status: 200, corpo: res };
    } catch (e) {
      if (e instanceof ErroEtl) throw erro.requisicao(e.message, e.detalhe);
      throw e;
    }
  });

  r.post('/api/importacao/:id/confirmar', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    try {
      await confirmarImportacao(db, id);
    } catch (e) {
      if (e instanceof ErroEtl) throw erro.conflito(e.message);
      throw e;
    }
    await auditor({ acao: 'importacao.confirmada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'importacao', entidadeId: id, ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true, ativa: id } };
  });

  r.post('/api/importacao/:id/reverter', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    const anterior = await reverterImportacao(db, id);
    await auditor({ acao: 'importacao.revertida', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'importacao', entidadeId: id, ip: req.ip, userAgent: req.userAgent,
      detalhe: { voltouPara: anterior } });
    return { status: 200, corpo: { ok: true, ativa: anterior } };
  });

  r.delete('/api/importacao/:id', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'gestor', 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    try {
      await descartarImportacao(db, id);
    } catch (e) {
      if (e instanceof ErroEtl) throw erro.conflito(e.message);
      throw e;
    }
    await auditor({ acao: 'importacao.descartada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'importacao', entidadeId: id, ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true } };
  });

  r.get('/api/importacao', async (req): Promise<Resposta> => {
    exigirPapel(req, 'gestor', 'admin');
    const ativa = await importacaoAtiva(db);
    const linhas = await db.all(
      `SELECT i.id, i.status, i.periodo_ini, i.periodo_fim, i.estatisticas, i.observacao,
              i.criado_em, i.confirmado_em, i.revertido_em, u.nome AS autor
         FROM importacoes i JOIN users u ON u.id = i.criado_por
        ORDER BY i.id DESC LIMIT 50`,
    );
    return {
      status: 200,
      corpo: {
        ativa,
        importacoes: linhas.map((l) => ({
          ...l,
          estatisticas: JSON.parse(String((l as Record<string, unknown>)['estatisticas'])),
        })),
      },
    };
  });

  // -------------------------------------------------------------------------
  // Administração
  // -------------------------------------------------------------------------

  r.get('/api/admin/consultores', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const linhas = await db.all(
      `SELECT c.id, c.nome, c.ativo, u.id AS user_id, u.email
         FROM consultores c LEFT JOIN users u ON u.consultor_id = c.id
        ORDER BY c.nome`,
    );
    return { status: 200, corpo: { consultores: linhas } };
  });

  /**
   * Ativa ou desativa um consultor. Existe porque a planilha do CRM traz
   * entradas que não são pessoas ("Equipe V2") ou que saíram da operação, e
   * elas poluem médias e ranking. Desativar preserva o histórico — o registro
   * continua no banco, apenas sai dos agregados.
   */
  r.patch('/api/admin/consultores/:id', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin', 'gestor');
    const id = str(req.params['id'], 'id', { max: 40 });
    const c = corpo(req);
    if (c['ativo'] === undefined) throw erro.requisicao('Informe o campo "ativo".');
    const ativo = c['ativo'] === true || c['ativo'] === 1 ? 1 : 0;

    const alvo = await db.get<{ nome: string }>('SELECT nome FROM consultores WHERE id = ?', [id]);
    if (!alvo) throw erro.naoEncontrado('Consultor não encontrado.');

    if (!ativo) {
      const vinculado = await db.get<{ email: string }>(
        'SELECT email FROM users WHERE consultor_id = ? AND ativo = 1', [id]);
      if (vinculado) {
        throw erro.conflito(
          `Este consultor está vinculado ao usuário ${vinculado.email}. ` +
          'Desative o usuário antes de desativar o consultor.',
        );
      }
    }

    await db.run('UPDATE consultores SET ativo = ? WHERE id = ?', [ativo, id]);
    await auditor({ acao: 'usuario.alterado', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'consultor', entidadeId: id, ip: req.ip, userAgent: req.userAgent,
      detalhe: { nome: alvo.nome, ativo: ativo === 1 } });
    return { status: 200, corpo: { ok: true, nome: alvo.nome, ativo: ativo === 1 } };
  });

  r.get('/api/admin/usuarios', async (req): Promise<Resposta> => {
    exigirPapel(req, 'admin', 'gestor');
    const linhas = await db.all(
      `SELECT u.id, u.email, u.nome, u.papel, u.consultor_id, c.nome AS consultor,
              u.ativo, u.pode_escrever, u.trocar_senha, u.ultimo_login, u.bloqueado_ate, u.criado_em
         FROM users u LEFT JOIN consultores c ON c.id = u.consultor_id
        ORDER BY u.papel, u.nome`,
    );
    return { status: 200, corpo: { usuarios: linhas } };
  });

  r.post('/api/admin/usuarios', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const c = corpo(req);
    const email = emailValido(c['email']);
    const nome = str(c['nome'], 'nome', { max: 120 });
    const papel = umDe<Papel>(c['papel'], 'papel', ['admin', 'gestor', 'consultor']);
    const consultorId = str(c['consultor_id'], 'consultor_id', { max: 40, obrigatorio: false });
    const podeEscrever = c['pode_escrever'] === false ? 0 : 1;

    if (papel === 'consultor' && !consultorId) {
      throw erro.requisicao('Um usuário do tipo consultor precisa estar vinculado a um consultor.');
    }
    if (consultorId) {
      const existe = await db.get('SELECT id FROM consultores WHERE id = ?', [consultorId]);
      if (!existe) throw erro.requisicao('Consultor informado não existe.');
      const jaTem = await db.get('SELECT id FROM users WHERE consultor_id = ?', [consultorId]);
      if (jaTem) throw erro.conflito('Este consultor já está vinculado a outro usuário.');
    }

    const senha = senhaProvisoria();
    const id = ulid();
    try {
      await db.run(
        `INSERT INTO users (id, email, nome, papel, consultor_id, senha_hash, trocar_senha,
                            pode_escrever, ativo, criado_em, atualizado_em)
         VALUES (?,?,?,?,?,?,1,?,1,?,?)`,
        [id, email, nome, papel, consultorId || null,
         await gerarHash(senha, cfg.segredoSenha), podeEscrever, agora(), agora()],
      );
    } catch (e) {
      if ((e as Error).name === 'UniqueViolation') throw erro.conflito('Já existe um usuário com esse e-mail.');
      throw e;
    }

    await auditor({ acao: 'usuario.criado', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'usuario', entidadeId: id, ip: req.ip, userAgent: req.userAgent,
      detalhe: { novoEmail: email, papel } });

    // A senha provisória aparece uma única vez, na resposta desta chamada.
    // Não fica no banco em claro nem é enviada por e-mail pelo sistema.
    return { status: 201, corpo: { id, email, senhaProvisoria: senha } };
  });

  r.patch('/api/admin/usuarios/:id', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    const c = corpo(req);

    const alvo = await db.get<{ id: string; email: string; papel: Papel }>(
      'SELECT id, email, papel FROM users WHERE id = ?', [id]);
    if (!alvo) throw erro.naoEncontrado('Usuário não encontrado.');

    const campos: string[] = [];
    const params: Array<string | number | null> = [];

    if (c['ativo'] !== undefined) {
      const ativo = c['ativo'] === true || c['ativo'] === 1 ? 1 : 0;
      if (!ativo && alvo.id === a.usuario.id) throw erro.requisicao('Você não pode desativar a própria conta.');
      if (!ativo && alvo.papel === 'admin') {
        const n = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE papel = 'admin' AND ativo = 1");
        if (Number(n?.n ?? 0) <= 1) throw erro.requisicao('Não é possível desativar o último administrador ativo.');
      }
      campos.push('ativo = ?'); params.push(ativo);
      if (!ativo) await revogarTodasDoUsuario(db, id);
    }
    if (c['pode_escrever'] !== undefined) {
      campos.push('pode_escrever = ?'); params.push(c['pode_escrever'] === true || c['pode_escrever'] === 1 ? 1 : 0);
    }
    if (c['nome'] !== undefined) { campos.push('nome = ?'); params.push(str(c['nome'], 'nome', { max: 120 })); }
    if (c['consultor_id'] !== undefined) {
      const cid = str(c['consultor_id'], 'consultor_id', { max: 40, obrigatorio: false }) || null;
      campos.push('consultor_id = ?'); params.push(cid);
    }
    if (c['desbloquear'] === true) { campos.push('falhas = 0', 'bloqueado_ate = NULL'); }

    let novaSenha: string | null = null;
    if (c['redefinir_senha'] === true) {
      novaSenha = senhaProvisoria();
      campos.push('senha_hash = ?', 'trocar_senha = 1');
      params.push(await gerarHash(novaSenha, cfg.segredoSenha));
      await revogarTodasDoUsuario(db, id);
    }

    if (campos.length === 0) throw erro.requisicao('Nenhum campo para alterar.');
    campos.push('atualizado_em = ?'); params.push(agora());
    params.push(id);
    await db.run(`UPDATE users SET ${campos.join(', ')} WHERE id = ?`, params);

    await auditor({
      acao: novaSenha ? 'senha.redefinida' : 'usuario.alterado',
      userId: a.usuario.id, email: a.usuario.email, entidade: 'usuario', entidadeId: id,
      ip: req.ip, userAgent: req.userAgent, detalhe: { campos: Object.keys(c) },
    });
    return { status: 200, corpo: { ok: true, senhaProvisoria: novaSenha } };
  });

  r.get('/api/admin/auditoria', async (req): Promise<Resposta> => {
    exigirPapel(req, 'admin', 'gestor');
    const limite = Math.min(Number(req.query.get('limite') ?? 200), 1000);
    const acao = req.query.get('acao');
    const linhas = await db.all(
      `SELECT id, criado_em, email, acao, entidade, entidade_id, sucesso, ip, detalhe
         FROM auditoria${acao ? ' WHERE acao = ?' : ''}
        ORDER BY id DESC LIMIT ?`,
      acao ? [acao, limite] : [limite],
    );
    return { status: 200, corpo: { registros: linhas } };
  });

  r.get('/api/saude', async (): Promise<Resposta> => {
    await db.get('SELECT 1 AS ok');
    return { status: 200, corpo: { ok: true, banco: db.dialect, hora: agora() } };
  });

  // -------------------------------------------------------------------------
  // Estáticos
  // -------------------------------------------------------------------------

  const TIPOS: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  async function servir(relativo: string): Promise<Resposta> {
    // normalize + prefixo obrigatório impedem traversal ("../../etc/passwd").
    const destino = join(dirWeb, normalize(relativo).replace(/^(\.\.[/\\])+/, ''));
    if (!destino.startsWith(dirWeb)) throw erro.naoEncontrado();
    try {
      const st = await stat(destino);
      if (!st.isFile()) throw erro.naoEncontrado();
      const bytes = await readFile(destino);
      const etag = `"${createHash('sha1').update(bytes).digest('base64url')}"`;
      const ext = extname(destino).toLowerCase();
      return {
        status: 200,
        buffer: bytes,
        cabecalhos: {
          'Content-Type': TIPOS[ext] ?? 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300, must-revalidate',
          ETag: etag,
        },
      };
    } catch {
      throw erro.naoEncontrado();
    }
  }

  r.get('/', () => servir('login.html'));
  r.get('/login', () => servir('login.html'));
  r.get('/painel', () => servir('app.html'));
  r.get('/favicon.ico', () => servir('favicon.svg'));
  r.get('/assets/:arquivo', (req) => servir(join('assets', req.params['arquivo']!)));

  return { roteador: r, auditor };
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function publico(u: { id: string; email: string; nome: string; papel: Papel; consultor_id: string | null; pode_escrever: number; trocar_senha: number }) {
  return {
    id: u.id, email: u.email, nome: u.nome, papel: u.papel,
    consultor_id: u.consultor_id,
    pode_escrever: u.pode_escrever === 1,
    trocar_senha: u.trocar_senha === 1,
  };
}

/** Média do time, melhor do time e posição, por métrica. */
function agregarReferencia(
  todos: Awaited<ReturnType<typeof resumoPorConsultor>>,
  consultorId: string,
) {
  const metricas: Array<{ campo: keyof typeof todos[number]; rotulo: string; maiorMelhor: boolean }> = [
    { campo: 'faturamento', rotulo: 'Faturamento creditado', maiorMelhor: true },
    { campo: 'contratos', rotulo: 'Contratos', maiorMelhor: true },
    { campo: 'opps', rotulo: 'Oportunidades tocadas', maiorMelhor: true },
    { campo: 'acoes', rotulo: 'Ações registradas', maiorMelhor: true },
    { campo: 'vencidas', rotulo: 'Pendências vencidas', maiorMelhor: false },
    { campo: 'deg_realizadas', rotulo: 'Degustações realizadas', maiorMelhor: true },
    { campo: 'deg_canceladas', rotulo: 'Degustações canceladas', maiorMelhor: false },
    { campo: 'perdas_evitaveis', rotulo: 'Perdas evitáveis', maiorMelhor: false },
  ];

  const eu = todos.find((t) => t.consultor_id === consultorId);
  const n = todos.length || 1;

  return {
    tamanhoTime: todos.length,
    metricas: metricas.map((m) => {
      const valores = todos.map((t) => Number(t[m.campo]));
      const meu = Number(eu?.[m.campo] ?? 0);
      const melhor = m.maiorMelhor ? Math.max(...valores) : Math.min(...valores);
      const idxMelhor = valores.indexOf(melhor);
      const ordenado = [...valores].sort((a, b) => (m.maiorMelhor ? b - a : a - b));
      return {
        campo: m.campo,
        rotulo: m.rotulo,
        maiorMelhor: m.maiorMelhor,
        meu,
        media: Number((valores.reduce((a, b) => a + b, 0) / n).toFixed(2)),
        melhor,
        melhorNome: todos[idxMelhor]?.nome ?? null,
        posicao: ordenado.indexOf(meu) + 1,
      };
    }),
  };
}
