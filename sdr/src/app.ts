/**
 * Montagem da aplicação: middlewares, rotas e arquivos estáticos.
 * Mesmo desenho do painel-comercial (server/src/app.ts), adaptado para
 * leads/mensagens/persona/regras em vez de oportunidades/CRM.
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
  exigirAuth, exigirPapel, carregarUsuario, type Autenticado, type Papel,
} from './auth/contexto.ts';
import {
  criarLead, buscarLead, buscarLeadPorTelefone, listarLeads, atualizarLead,
  listarMensagens,
} from './domain/leads.ts';
import { obterPersona, definirPersona, obterRegras, definirRegras } from './domain/config.ts';
import { tratarMensagemRecebida, varrerLeadsDevidos } from './domain/mensagens.ts';
import {
  verificarWebhook, extrairMensagensInbound, normalizarTelefone, enviar as enviarWhatsapp,
} from './integracoes/whatsapp.ts';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ROTAS_PUBLICAS_API = new Set(['/api/whatsapp/webhook', '/api/saude']);

export interface Aplicacao {
  roteador: Roteador;
  auditor: Auditor;
}

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

const ESTAGIOS = [
  'novo', 'aquecendo', 'aguardando_resposta', 'respondeu', 'quente', 'convertido', 'perdido', 'pausado',
] as const;

export function montarApp(db: Db, cfg: Config, dirWeb: string): Aplicacao {
  const r = new Roteador();
  const auditor = criarAuditor(db, (e) => console.error('[auditoria] falha ao gravar:', e));

  const limitePorIp = new LimitadorTaxa(cfg.login.maxPorIp, cfg.login.janelaMs, cfg.login.janelaMs);
  const limiteApi = new LimitadorTaxa(600, 60_000);
  const limiteEscrita = new LimitadorTaxa(120, 60_000);
  const limiteWebhook = new LimitadorTaxa(300, 60_000);

  const cookieSessao = (valor: string, maxAge?: number): CookieDef => ({
    nome: cfg.sessao.nomeCookie, valor, httpOnly: true, secure: cfg.https,
    sameSite: 'Strict', caminho: '/', maxAgeSegundos: maxAge,
  });
  const cookieCsrf = (valor: string, maxAge?: number): CookieDef => ({
    nome: cfg.sessao.nomeCookieCsrf, valor, httpOnly: false, secure: cfg.https,
    sameSite: 'Strict', caminho: '/', maxAgeSegundos: maxAge,
  });
  const cookiesLimpos = (): CookieDef[] => [
    { ...cookieSessao(''), expiraJa: true },
    { ...cookieCsrf(''), expiraJa: true },
  ];

  const agora = () => new Date().toISOString();

  // -------------------------------------------------------------------------
  // Middleware: sessão, CSRF, origem, limite
  // -------------------------------------------------------------------------

  r.usar(async (req) => {
    const api = req.caminho.startsWith('/api/');
    const publica = ROTAS_PUBLICAS_API.has(req.caminho);

    if (api) {
      if (req.caminho === '/api/whatsapp/webhook') {
        const l = limiteWebhook.verificar(req.ip);
        if (!l.permitido) throw erro.excesso();
      } else {
        const l = METODOS_SEGUROS.has(req.metodo)
          ? limiteApi.verificar(req.ip)
          : limiteEscrita.verificar(req.ip);
        if (!l.permitido) throw erro.excesso();
      }
    }

    // O webhook do WhatsApp é chamado pela Meta, não pelo navegador: não
    // manda cookie, Origin nem CSRF. Fica de fora dessa barreira, mas ainda
    // passa pelo rate limit acima.
    if (publica) return;

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

    const generico = 'E-mail ou senha incorretos.';

    if (!u || !u.ativo) {
      await verificarDummy(cfg.segredoSenha);
      await auditor({ acao: 'login.falha', email, sucesso: false, ip: req.ip,
        userAgent: req.userAgent, detalhe: { motivo: u ? 'inativo' : 'inexistente' } });
      throw erro.naoAutenticado(generico);
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
      throw erro.naoAutenticado(generico);
    }

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
    const s = await db.get<{ csrf_hash: string }>('SELECT csrf_hash FROM sessoes WHERE id = ?', [a.sessaoId]);
    return { status: 200, corpo: { usuario: publico(a.usuario), csrfAtivo: !!s } };
  });

  r.post('/api/auth/senha', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const c = corpo(req);
    const atual = str(c['atual'], 'atual', { max: 200 });
    const nova = str(c['nova'], 'nova', { max: 200 });

    const u = await db.get<{ senha_hash: string }>('SELECT senha_hash FROM users WHERE id = ?', [a.usuario.id]);
    if (!u || !(await verificarHash(atual, u.senha_hash, cfg.segredoSenha))) {
      throw erro.requisicao('A senha atual está incorreta.');
    }
    if (nova === atual) throw erro.requisicao('A nova senha precisa ser diferente da atual.');

    const pol = validarPolitica(nova, [a.usuario.email, a.usuario.nome]);
    if (!pol.ok) throw erro.requisicao(pol.erros[0]!, { erros: pol.erros });

    await db.run(
      'UPDATE users SET senha_hash = ?, trocar_senha = 0, senha_alterada_em = ?, atualizado_em = ? WHERE id = ?',
      [await gerarHash(nova, cfg.segredoSenha), agora(), agora(), a.usuario.id],
    );
    const encerradas = await revogarTodasDoUsuario(db, a.usuario.id, a.sessaoId);
    await auditor({ acao: 'senha.alterada', userId: a.usuario.id, email: a.usuario.email,
      ip: req.ip, userAgent: req.userAgent, detalhe: { sessoesEncerradas: encerradas } });
    return { status: 200, corpo: { ok: true, sessoesEncerradas: encerradas } };
  });

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------

  r.get('/api/leads', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const estagio = req.query.get('estagio');
    const responsavel = req.query.get('responsavel');
    const busca = req.query.get('busca');
    const leads = await listarLeads(db, {
      estagio: estagio || null, responsavelId: responsavel || null, busca: busca || null,
    });
    return { status: 200, corpo: { leads } };
  });

  r.post('/api/leads', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const c = corpo(req);
    const nome = str(c['nome'], 'nome', { max: 150 });
    const telefone = str(c['telefone'], 'telefone', { max: 30, min: 8 });
    const email = str(c['email'], 'email', { max: 200, obrigatorio: false });
    const origem = str(c['origem'], 'origem', { max: 100, obrigatorio: false });
    const contexto = str(c['contexto'], 'contexto', { max: 2000, obrigatorio: false });
    const responsavelId = str(c['responsavel_id'], 'responsavel_id', { max: 40, obrigatorio: false });

    try {
      const lead = await criarLead(db, {
        nome, telefone, email: email || null, origem: origem || null,
        contexto: contexto || null, responsavelId: responsavelId || null,
      }, a.usuario.id);
      await auditor({ acao: 'lead.criado', userId: a.usuario.id, email: a.usuario.email,
        entidade: 'lead', entidadeId: lead.id, ip: req.ip, userAgent: req.userAgent });
      return { status: 201, corpo: { lead } };
    } catch (e) {
      if ((e as Error).name === 'UniqueViolation') {
        throw erro.conflito('Já existe um lead cadastrado com esse telefone.');
      }
      throw e;
    }
  });

  r.get('/api/leads/:id', async (req): Promise<Resposta> => {
    exigirAuth(req);
    const id = str(req.params['id'], 'id', { max: 40 });
    const lead = await buscarLead(db, id);
    if (!lead) throw erro.naoEncontrado('Lead não encontrado.');
    const mensagens = await listarMensagens(db, id);
    return { status: 200, corpo: { lead, mensagens } };
  });

  r.patch('/api/leads/:id', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const id = str(req.params['id'], 'id', { max: 40 });
    const lead = await buscarLead(db, id);
    if (!lead) throw erro.naoEncontrado('Lead não encontrado.');
    const c = corpo(req);

    const campos: Record<string, string | number | null> = {};
    if (c['nome'] !== undefined) campos['nome'] = str(c['nome'], 'nome', { max: 150 });
    if (c['email'] !== undefined) campos['email'] = str(c['email'], 'email', { max: 200, obrigatorio: false }) || null;
    if (c['origem'] !== undefined) campos['origem'] = str(c['origem'], 'origem', { max: 100, obrigatorio: false }) || null;
    if (c['contexto'] !== undefined) campos['contexto'] = str(c['contexto'], 'contexto', { max: 2000, obrigatorio: false }) || null;
    if (c['responsavel_id'] !== undefined) campos['responsavel_id'] = str(c['responsavel_id'], 'responsavel_id', { max: 40, obrigatorio: false }) || null;
    if (c['estagio'] !== undefined) campos['estagio'] = umDe(c['estagio'], 'estagio', ESTAGIOS);
    if (c['automacao_ativa'] !== undefined) campos['automacao_ativa'] = c['automacao_ativa'] ? 1 : 0;

    await atualizarLead(db, id, campos as never);
    await auditor({
      acao: c['automacao_ativa'] === false ? 'lead.pausado' : c['automacao_ativa'] === true ? 'lead.retomado' : 'lead.alterado',
      userId: a.usuario.id, email: a.usuario.email, entidade: 'lead', entidadeId: id,
      ip: req.ip, userAgent: req.userAgent, detalhe: { campos: Object.keys(campos) },
    });
    return { status: 200, corpo: { ok: true } };
  });

  /** Mensagem escrita e enviada por um humano — sem passar pela I.A. nem pelas regras de cadência. */
  r.post('/api/leads/:id/mensagens', async (req): Promise<Resposta> => {
    const a = exigirAuth(req);
    const id = str(req.params['id'], 'id', { max: 40 });
    const lead = await buscarLead(db, id);
    if (!lead) throw erro.naoEncontrado('Lead não encontrado.');
    const texto = str(corpo(req)['texto'], 'texto', { max: 2000 });

    const resultado = await enviarWhatsapp(
      { modo: cfg.whatsapp.modo, token: cfg.whatsapp.token, phoneNumberId: cfg.whatsapp.phoneNumberId,
        verifyToken: cfg.whatsapp.verifyToken, apiVersion: cfg.whatsapp.apiVersion },
      lead.telefone, texto,
    );
    const agoraIso = agora();
    await db.run(
      `INSERT INTO mensagens (id, lead_id, direcao, canal, texto, gerada_por_ia, status, erro, criado_por, criado_em, enviada_em)
       VALUES (?, ?, 'saida', 'whatsapp', ?, 0, ?, ?, ?, ?, ?)`,
      [ulid(), id, texto, resultado.ok ? (resultado.simulado ? 'simulada' : 'enviada') : 'falhou',
       resultado.erro ?? null, a.usuario.id, agoraIso, resultado.ok ? agoraIso : null],
    );
    // Mensagem humana pausa a cadência automática: quem está no controle agora é a pessoa.
    await atualizarLead(db, id, { automacao_ativa: 0 });
    await auditor({ acao: 'mensagem.enviada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'lead', entidadeId: id, sucesso: resultado.ok, ip: req.ip, userAgent: req.userAgent,
      detalhe: { manual: true, simulado: resultado.simulado } });
    if (!resultado.ok) throw erro.requisicao(`Falha ao enviar: ${resultado.erro ?? 'desconhecida'}`);
    return { status: 201, corpo: { ok: true, simulado: resultado.simulado } };
  });

  // -------------------------------------------------------------------------
  // Configuração: persona e regras (admin)
  // -------------------------------------------------------------------------

  r.get('/api/config/persona', async (req): Promise<Resposta> => {
    exigirAuth(req);
    return { status: 200, corpo: { persona: await obterPersona(db) } };
  });

  r.put('/api/config/persona', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const c = corpo(req);
    const persona = {
      nomeEmpresa: str(c['nomeEmpresa'], 'nomeEmpresa', { max: 150 }),
      nomeAtendente: str(c['nomeAtendente'], 'nomeAtendente', { max: 150 }),
      tom: str(c['tom'], 'tom', { max: 500 }),
      diretrizes: str(c['diretrizes'], 'diretrizes', { max: 2000, obrigatorio: false }),
    };
    await definirPersona(db, persona, a.usuario.id);
    await auditor({ acao: 'config.alterada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'config', entidadeId: 'persona', ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true } };
  });

  r.get('/api/config/regras', async (req): Promise<Resposta> => {
    exigirAuth(req);
    return { status: 200, corpo: { regras: await obterRegras(db) } };
  });

  r.put('/api/config/regras', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const c = corpo(req) as Record<string, unknown>;
    const regrasAtuais = await obterRegras(db);
    // Aceita atualização parcial; o que não vier mantém o valor atual.
    const regras = { ...regrasAtuais, ...c } as typeof regrasAtuais;
    await definirRegras(db, regras, a.usuario.id);
    await auditor({ acao: 'config.alterada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'config', entidadeId: 'regras', ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true, regras } };
  });

  // -------------------------------------------------------------------------
  // Administração de usuários
  // -------------------------------------------------------------------------

  r.get('/api/admin/usuarios', async (req): Promise<Resposta> => {
    exigirPapel(req, 'admin');
    const linhas = await db.all(
      `SELECT id, email, nome, papel, ativo, trocar_senha, ultimo_login, bloqueado_ate, criado_em
         FROM users ORDER BY papel, nome`,
    );
    return { status: 200, corpo: { usuarios: linhas } };
  });

  r.post('/api/admin/usuarios', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const c = corpo(req);
    const email = emailValido(c['email']);
    const nome = str(c['nome'], 'nome', { max: 120 });
    const papel = umDe<Papel>(c['papel'], 'papel', ['admin', 'comercial']);

    const senha = senhaProvisoria();
    const id = ulid();
    try {
      await db.run(
        `INSERT INTO users (id, email, nome, papel, senha_hash, trocar_senha, ativo, criado_em, atualizado_em)
         VALUES (?,?,?,?,?,1,1,?,?)`,
        [id, email, nome, papel, await gerarHash(senha, cfg.segredoSenha), agora(), agora()],
      );
    } catch (e) {
      if ((e as Error).name === 'UniqueViolation') throw erro.conflito('Já existe um usuário com esse e-mail.');
      throw e;
    }
    await auditor({ acao: 'usuario.criado', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'usuario', entidadeId: id, ip: req.ip, userAgent: req.userAgent, detalhe: { novoEmail: email, papel } });
    return { status: 201, corpo: { id, email, senhaProvisoria: senha } };
  });

  r.patch('/api/admin/usuarios/:id', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const id = str(req.params['id'], 'id', { max: 40 });
    const c = corpo(req);
    const alvo = await db.get<{ id: string; papel: Papel }>('SELECT id, papel FROM users WHERE id = ?', [id]);
    if (!alvo) throw erro.naoEncontrado('Usuário não encontrado.');

    const campos: string[] = [];
    const params: Array<string | number | null> = [];
    if (c['ativo'] !== undefined) {
      const ativo = c['ativo'] === true || c['ativo'] === 1 ? 1 : 0;
      if (!ativo && alvo.id === a.usuario.id) throw erro.requisicao('Você não pode desativar a própria conta.');
      campos.push('ativo = ?'); params.push(ativo);
      if (!ativo) await revogarTodasDoUsuario(db, id);
    }
    if (c['nome'] !== undefined) { campos.push('nome = ?'); params.push(str(c['nome'], 'nome', { max: 120 })); }
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
    await auditor({ acao: 'usuario.alterado', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'usuario', entidadeId: id, ip: req.ip, userAgent: req.userAgent });
    return { status: 200, corpo: { ok: true, senhaProvisoria: novaSenha } };
  });

  r.get('/api/admin/auditoria', async (req): Promise<Resposta> => {
    exigirPapel(req, 'admin');
    const limite = Math.min(Number(req.query.get('limite') ?? 200), 1000);
    const linhas = await db.all(
      `SELECT id, criado_em, email, acao, entidade, entidade_id, sucesso, ip, detalhe
         FROM auditoria ORDER BY id DESC LIMIT ?`,
      [limite],
    );
    return { status: 200, corpo: { registros: linhas } };
  });

  // -------------------------------------------------------------------------
  // Webhook do WhatsApp (Meta Cloud API) — sem sessão, chamado pela Meta.
  // -------------------------------------------------------------------------

  r.get('/api/whatsapp/webhook', (req): Resposta => {
    const desafio = verificarWebhook(req.query, cfg.whatsapp.verifyToken);
    if (desafio === null) throw erro.proibido('Verificação de webhook falhou.');
    return { status: 200, texto: desafio, cabecalhos: { 'Content-Type': 'text/plain' } };
  });

  r.post('/api/whatsapp/webhook', async (req): Promise<Resposta> => {
    const mensagens = extrairMensagensInbound(req.corpo);
    const regras = await obterRegras(db);
    for (const m of mensagens) {
      const lead = await buscarLeadPorTelefone(db, m.telefone);
      if (!lead) {
        // Mensagem de um número que não está na base: registra como lead
        // novo, já em "respondeu", para nada se perder — mas sem automação
        // (a fila de aquecimento é para leads que a equipe cadastrou).
        const criado = await criarLead(db, {
          nome: normalizarTelefone(m.telefone), telefone: m.telefone, origem: 'whatsapp_inbound',
        }, 'sistema');
        await atualizarLead(db, criado.id, { automacao_ativa: 0, estagio: 'respondeu' });
        await tratarMensagemRecebida(db, auditor, criado.id, m.texto, regras, m.idExterno);
        continue;
      }
      await tratarMensagemRecebida(db, auditor, lead.id, m.texto, regras, m.idExterno);
    }
    return { status: 200, corpo: { ok: true, processadas: mensagens.length } };
  });

  r.get('/api/saude', async (): Promise<Resposta> => {
    await db.get('SELECT 1 AS ok');
    return { status: 200, corpo: { ok: true, banco: db.dialect, hora: agora() } };
  });

  // -------------------------------------------------------------------------
  // Varredura manual (admin) — dispara a varredura de leads devidos na hora,
  // sem esperar o próximo ciclo do temporizador. Útil em teste e demonstração.
  // -------------------------------------------------------------------------

  r.post('/api/varredura', async (req): Promise<Resposta> => {
    const a = exigirPapel(req, 'admin');
    const persona = await obterPersona(db);
    const regras = await obterRegras(db);
    const resultados = await varrerLeadsDevidos(db, persona, regras, cfg.ia, {
      modo: cfg.whatsapp.modo, token: cfg.whatsapp.token, phoneNumberId: cfg.whatsapp.phoneNumberId,
      verifyToken: cfg.whatsapp.verifyToken, apiVersion: cfg.whatsapp.apiVersion,
    }, auditor);
    await auditor({ acao: 'config.alterada', userId: a.usuario.id, email: a.usuario.email,
      entidade: 'varredura', ip: req.ip, userAgent: req.userAgent,
      detalhe: { processados: resultados.length, enviados: resultados.filter((r2) => r2.enviado).length } });
    return { status: 200, corpo: { resultados } };
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
  };

  async function servir(relativo: string): Promise<Resposta> {
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

function publico(u: { id: string; email: string; nome: string; papel: Papel; trocar_senha: number }) {
  return {
    id: u.id, email: u.email, nome: u.nome, papel: u.papel,
    trocar_senha: u.trocar_senha === 1,
  };
}
