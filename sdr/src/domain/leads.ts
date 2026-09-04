/**
 * CRUD e consultas de leads. A fila é do time inteiro — não há isolamento
 * por consultor como no painel-comercial, porque aqui o objetivo é
 * distribuir e acompanhar o aquecimento em conjunto.
 */

import type { Db } from '../db/index.ts';
import { ulid } from '../lib/ids.ts';
import { normalizarTelefone } from '../integracoes/whatsapp.ts';
import type { LinhaLeadImportado } from '../lib/csv.ts';

export interface Lead {
  id: string;
  nome: string;
  telefone: string;
  email: string | null;
  origem: string | null;
  contexto: string | null;
  estagio: string;
  responsavel_id: string | null;
  opt_out: number;
  automacao_ativa: number;
  qualificacao_ativa: number;
  qualificacao_mensagens: number;
  sequencia_passo: number;
  mensagens_sem_resposta: number;
  proxima_mensagem_em: string | null;
  ultima_mensagem_em: string | null;
  ultima_resposta_em: string | null;
  criado_por: string;
  criado_em: string;
  atualizado_em: string;
}

export interface NovoLead {
  nome: string;
  telefone: string;
  email?: string | null;
  origem?: string | null;
  contexto?: string | null;
  responsavelId?: string | null;
}

export async function criarLead(db: Db, dados: NovoLead, criadoPor: string): Promise<Lead> {
  const agora = new Date().toISOString();
  const id = ulid();
  const telefone = normalizarTelefone(dados.telefone);
  await db.run(
    `INSERT INTO leads
       (id, nome, telefone, email, origem, contexto, estagio, responsavel_id,
        opt_out, automacao_ativa, sequencia_passo, mensagens_sem_resposta,
        proxima_mensagem_em, criado_por, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, 'novo', ?, 0, 1, 0, 0, ?, ?, ?, ?)`,
    [
      id, dados.nome.trim(), telefone, dados.email?.trim() || null,
      dados.origem?.trim() || null, dados.contexto?.trim() || null,
      dados.responsavelId || null, agora, criadoPor, agora, agora,
    ],
  );
  return (await buscarLead(db, id))!;
}

export interface ResultadoImportacao {
  criados: number;
  duplicados: number;
  erros: Array<{ linha: number; motivo: string }>;
}

/**
 * Cria um lead por linha reconhecida do CSV, pulando (sem travar o resto do
 * arquivo) quem já existe pelo telefone — nunca sobrescreve um lead ou
 * conversa existente por engano. Cada linha ainda passa pela mesma
 * validação de criarLead().
 */
export async function importarLeads(
  db: Db,
  linhas: Array<{ numero: number; dados: LinhaLeadImportado | null; motivo: string | null }>,
  criadoPor: string,
  responsavelId: string | null = null,
): Promise<ResultadoImportacao> {
  const resultado: ResultadoImportacao = { criados: 0, duplicados: 0, erros: [] };
  for (const linha of linhas) {
    if (!linha.dados) {
      resultado.erros.push({ linha: linha.numero, motivo: linha.motivo ?? 'linha inválida' });
      continue;
    }
    try {
      const existente = await buscarLeadPorTelefone(db, linha.dados.telefone);
      if (existente) { resultado.duplicados++; continue; }
      await criarLead(db, { ...linha.dados, responsavelId }, criadoPor);
      resultado.criados++;
    } catch (e) {
      resultado.erros.push({ linha: linha.numero, motivo: String(e) });
    }
  }
  return resultado;
}

export async function buscarLead(db: Db, id: string): Promise<Lead | null> {
  return db.get<Lead>('SELECT * FROM leads WHERE id = ?', [id]);
}

export async function buscarLeadPorTelefone(db: Db, telefone: string): Promise<Lead | null> {
  return db.get<Lead>('SELECT * FROM leads WHERE telefone = ?', [normalizarTelefone(telefone)]);
}

export interface FiltroLeads {
  estagio?: string | null;
  responsavelId?: string | null;
  busca?: string | null;
}

export async function listarLeads(db: Db, filtro: FiltroLeads = {}): Promise<Lead[]> {
  const onde: string[] = [];
  const params: (string | number)[] = [];
  if (filtro.estagio) { onde.push('estagio = ?'); params.push(filtro.estagio); }
  if (filtro.responsavelId) { onde.push('responsavel_id = ?'); params.push(filtro.responsavelId); }
  if (filtro.busca) {
    onde.push('(nome LIKE ? OR telefone LIKE ?)');
    params.push(`%${filtro.busca}%`, `%${filtro.busca}%`);
  }
  const clausula = onde.length ? `WHERE ${onde.join(' AND ')}` : '';
  // Prévia da última mensagem (texto + direção) pra lista de conversas
  // parecer lista de conversas de verdade, não só um cadastro de contatos.
  return db.all<Lead & { ultima_mensagem_texto: string | null; ultima_mensagem_direcao: string | null }>(
    `SELECT leads.*,
            (SELECT texto FROM mensagens m WHERE m.lead_id = leads.id ORDER BY m.criado_em DESC LIMIT 1) AS ultima_mensagem_texto,
            (SELECT direcao FROM mensagens m WHERE m.lead_id = leads.id ORDER BY m.criado_em DESC LIMIT 1) AS ultima_mensagem_direcao
       FROM leads ${clausula} ORDER BY atualizado_em DESC LIMIT 500`,
    params,
  );
}

export async function listarLeadsDevidos(db: Db, agoraIso: string, limite = 50): Promise<Lead[]> {
  return db.all<Lead>(
    `SELECT * FROM leads
      WHERE opt_out = 0 AND automacao_ativa = 1
        AND estagio NOT IN ('respondeu','quente','convertido','perdido','pausado')
        AND (proxima_mensagem_em IS NULL OR proxima_mensagem_em <= ?)
      ORDER BY proxima_mensagem_em ASC
      LIMIT ?`,
    [agoraIso, limite],
  );
}

export async function atualizarLead(
  db: Db,
  id: string,
  campos: Partial<Pick<Lead, 'nome' | 'email' | 'origem' | 'contexto' | 'estagio' | 'responsavel_id' | 'automacao_ativa'>>,
): Promise<void> {
  const chaves = Object.keys(campos) as Array<keyof typeof campos>;
  if (chaves.length === 0) return;
  const set = chaves.map((k) => `${k} = ?`).join(', ');
  const valores = chaves.map((k) => campos[k] as string | number | null);
  await db.run(`UPDATE leads SET ${set}, atualizado_em = ? WHERE id = ?`, [
    ...valores, new Date().toISOString(), id,
  ]);
}

/** Apaga o lead e todas as mensagens dele (ON DELETE CASCADE) — irreversível. */
export async function excluirLead(db: Db, id: string): Promise<void> {
  await db.run('DELETE FROM leads WHERE id = ?', [id]);
}

export async function marcarOptOut(db: Db, id: string): Promise<void> {
  await db.run(
    `UPDATE leads SET opt_out = 1, automacao_ativa = 0, atualizado_em = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

/** Registra que a I.A. mandou mais uma mensagem de qualificação, sem encerrar a fase ainda. */
export async function avancarQualificacao(db: Db, id: string, novoContador: number): Promise<void> {
  await db.run(
    `UPDATE leads SET qualificacao_ativa = 1, qualificacao_mensagens = ?, atualizado_em = ? WHERE id = ?`,
    [novoContador, new Date().toISOString(), id],
  );
}

/**
 * Encerra a fase de qualificação (completa, capada no teto de mensagens, ou
 * interrompida por erro) — a partir daqui é 100% humano de novo. Quando há
 * resumo da I.A., anexa ao contexto do lead (não sobrescreve o que já tinha).
 */
export async function encerrarQualificacao(
  db: Db, id: string, opts: { estagio: string; resumo?: string | null },
): Promise<void> {
  const agora = new Date().toISOString();
  if (opts.resumo) {
    const atual = await buscarLead(db, id);
    const contexto = [atual?.contexto, `[Resumo da I.A.]\n${opts.resumo}`].filter(Boolean).join('\n\n');
    await db.run(
      `UPDATE leads SET qualificacao_ativa = 0, estagio = ?, contexto = ?, atualizado_em = ? WHERE id = ?`,
      [opts.estagio, contexto, agora, id],
    );
  } else {
    await db.run(
      `UPDATE leads SET qualificacao_ativa = 0, estagio = ?, atualizado_em = ? WHERE id = ?`,
      [opts.estagio, agora, id],
    );
  }
}

export async function registrarResposta(db: Db, id: string): Promise<void> {
  const agora = new Date().toISOString();
  await db.run(
    `UPDATE leads SET estagio = 'respondeu', mensagens_sem_resposta = 0,
                       ultima_resposta_em = ?, atualizado_em = ? WHERE id = ?`,
    [agora, agora, id],
  );
}

export async function avancarSequencia(
  db: Db,
  id: string,
  novoPasso: number,
  proximaMensagemEm: string | null,
  novoEstagio: string,
): Promise<void> {
  const agora = new Date().toISOString();
  await db.run(
    `UPDATE leads
        SET sequencia_passo = ?, proxima_mensagem_em = ?, estagio = ?,
            ultima_mensagem_em = ?, mensagens_sem_resposta = mensagens_sem_resposta + 1,
            atualizado_em = ?
      WHERE id = ?`,
    [novoPasso, proximaMensagemEm, novoEstagio, agora, agora, id],
  );
}

export async function listarMensagens(db: Db, leadId: string, limite = 200) {
  return db.all(
    `SELECT id, direcao, canal, texto, gerada_por_ia, status, erro, entrega_status, criado_em, enviada_em
       FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC LIMIT ?`,
    [leadId, limite],
  );
}

/**
 * Aplica uma atualização de status de entrega (webhook `statuses` da Meta)
 * na mensagem de saída correspondente. "read" nunca regride pra "delivered"
 * chegando fora de ordem — a Meta pode reenviar/atrasar eventos.
 */
export async function atualizarStatusEntrega(
  db: Db,
  idExterno: string,
  status: 'enviada' | 'entregue' | 'lida' | 'falhou',
): Promise<void> {
  const ORDEM = { enviada: 0, entregue: 1, lida: 2, falhou: 0 };
  const atual = await db.get<{ id: string; entrega_status: string | null }>(
    'SELECT id, entrega_status FROM mensagens WHERE mensagem_externa_id = ? AND direcao = ?',
    [idExterno, 'saida'],
  );
  if (!atual) return;
  const atualOrdem = atual.entrega_status ? ORDEM[atual.entrega_status as keyof typeof ORDEM] ?? -1 : -1;
  if (status !== 'falhou' && atualOrdem >= ORDEM[status]) return;
  await db.run('UPDATE mensagens SET entrega_status = ? WHERE id = ?', [status, atual.id]);
}

export async function contarEnviadasHoje(db: Db, agora: Date): Promise<number> {
  const inicioDia = new Date(agora); inicioDia.setHours(0, 0, 0, 0);
  const r = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mensagens
      WHERE direcao = 'saida' AND gerada_por_ia = 1 AND status IN ('enviada','simulada')
        AND criado_em >= ?`,
    [inicioDia.toISOString()],
  );
  return Number(r?.n ?? 0);
}
