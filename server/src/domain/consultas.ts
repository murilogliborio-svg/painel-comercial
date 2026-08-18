/**
 * Consultas do painel.
 *
 * REGRA DE OURO DESTE ARQUIVO
 * ---------------------------
 * Toda função que devolve dado de cliente recebe `consultorId: string | null`
 * e, quando ele não é nulo, o filtro entra no WHERE — nunca em `.filter()`
 * de JavaScript depois da consulta, nunca no frontend. Quem decide o valor
 * desse parâmetro é `escopoConsultor()` (auth/contexto.ts), que só devolve
 * null para gestor e admin.
 *
 * Ao acrescentar uma consulta nova aqui, mantenha a assinatura e acrescente
 * o caso correspondente em `test/isolamento.test.ts`.
 */

import type { Db } from '../db/index.ts';
import { paraReais } from '../lib/valores.ts';

/** Fragmento de filtro reaproveitado. Devolve SQL e parâmetro. */
function filtroConsultor(coluna: string, consultorId: string | null): { sql: string; params: string[] } {
  return consultorId ? { sql: ` AND ${coluna} = ?`, params: [consultorId] } : { sql: '', params: [] };
}

export interface ResumoConsultor {
  consultor_id: string;
  nome: string;
  opps: number;
  acoes: number;
  concluidas: number;
  pendentes: number;
  vencidas: number;
  deg_total: number;
  deg_realizadas: number;
  deg_canceladas: number;
  deg_confirmadas: number;
  perdidos: number;
  perdas_evitaveis: number;
  contratos: number;
  faturamento: number;
}

/** Motivos considerados evitáveis: o processo comercial ainda podia agir. */
export const MOTIVOS_EVITAVEIS = [
  'CLIENTE PERDIDO - SEM RETORNO DO CLIENTE',
  'CLIENTE PERDIDO POR PREÇO',
  'CLIENTE PERDIDO PARA CONCORRENTE',
];

export const MOTIVOS_PERDA = [
  'DESQUALIFICADO',
  'CLIENTE/EVENTO SEM PERFIL',
  ...MOTIVOS_EVITAVEIS,
  'DESISTIU POR MOTIVOS PESSOAIS',
  'CLIENTE PERDIDO POR DATA',
  'CLIENTE DUPLICADO',
];

function inLista(valores: string[]): string {
  return valores.map(() => '?').join(',');
}

/**
 * Resumo por consultor. É a base do ranking do gestor e do painel individual.
 * Uma única consulta com agregações correlacionadas: em bases desta ordem de
 * grandeza (milhares de linhas) é mais rápido e muito mais legível do que
 * várias consultas costuradas na aplicação.
 */
export async function resumoPorConsultor(
  db: Db, importId: string, agoraIso: string, consultorId: string | null,
): Promise<ResumoConsultor[]> {
  const f = filtroConsultor('c.id', consultorId);

  const linhas = await db.all<Record<string, number | string>>(
    `SELECT
       c.id   AS consultor_id,
       c.nome AS nome,
       (SELECT COUNT(DISTINCT a.num_oportunidade) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id) AS opps,
       (SELECT COUNT(*) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id) AS acoes,
       (SELECT COUNT(*) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id AND a.status_acao = 'Concluído') AS concluidas,
       (SELECT COUNT(*) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id AND a.status_acao = 'Pendente') AS pendentes,
       (SELECT COUNT(*) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id AND a.status_acao = 'Pendente'
            AND a.dt_agendado IS NOT NULL AND a.dt_agendado < ?) AS vencidas,
       (SELECT COUNT(*) FROM degustacoes d
          WHERE d.import_id = ? AND d.consultor_id = c.id) AS deg_total,
       (SELECT COUNT(*) FROM degustacoes d
          WHERE d.import_id = ? AND d.consultor_id = c.id AND d.status = 'REALIZADO') AS deg_realizadas,
       (SELECT COUNT(*) FROM degustacoes d
          WHERE d.import_id = ? AND d.consultor_id = c.id AND d.status = 'CANCELADO') AS deg_canceladas,
       (SELECT COUNT(*) FROM degustacoes d
          WHERE d.import_id = ? AND d.consultor_id = c.id AND d.status = 'CONFIRMADO') AS deg_confirmadas,
       (SELECT COUNT(DISTINCT a.num_oportunidade) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id
            AND a.acao IN (${inLista(MOTIVOS_PERDA)})) AS perdidos,
       (SELECT COUNT(DISTINCT a.num_oportunidade) FROM acoes a
          WHERE a.import_id = ? AND a.consultor_id = c.id
            AND a.acao IN (${inLista(MOTIVOS_EVITAVEIS)})) AS perdas_evitaveis,
       COALESCE((SELECT SUM(k.quantidade) FROM contrato_creditos k
          WHERE k.import_id = ? AND k.consultor_id = c.id), 0) AS contratos,
       COALESCE((SELECT SUM(k.valor_c) FROM contrato_creditos k
          WHERE k.import_id = ? AND k.consultor_id = c.id), 0) AS faturamento_c
     FROM consultores c
     WHERE c.ativo = 1${f.sql}
       AND (EXISTS (SELECT 1 FROM acoes a WHERE a.import_id = ? AND a.consultor_id = c.id)
         OR EXISTS (SELECT 1 FROM degustacoes d WHERE d.import_id = ? AND d.consultor_id = c.id))
     ORDER BY faturamento_c DESC, c.nome ASC`,
    [
      importId, importId, importId, importId, importId, agoraIso,
      importId, importId, importId, importId,
      importId, ...MOTIVOS_PERDA,
      importId, ...MOTIVOS_EVITAVEIS,
      importId, importId,
      ...f.params,
      importId, importId,
    ],
  );

  return linhas.map((l) => ({
    consultor_id: String(l['consultor_id']),
    nome: String(l['nome']),
    opps: Number(l['opps']),
    acoes: Number(l['acoes']),
    concluidas: Number(l['concluidas']),
    pendentes: Number(l['pendentes']),
    vencidas: Number(l['vencidas']),
    deg_total: Number(l['deg_total']),
    deg_realizadas: Number(l['deg_realizadas']),
    deg_canceladas: Number(l['deg_canceladas']),
    deg_confirmadas: Number(l['deg_confirmadas']),
    perdidos: Number(l['perdidos']),
    perdas_evitaveis: Number(l['perdas_evitaveis']),
    contratos: Number(l['contratos']),
    faturamento: paraReais(Number(l['faturamento_c'])),
  }));
}

export interface TotaisGerais {
  oportunidades: number;
  acoes: number;
  pendentes: number;
  vencidas: number;
  degustacoes: number;
  deg_canceladas: number;
  contratos: number;
  faturamento: number;
  ticket_medio: number;
  desconto_pct: number;
  abaixo_minimo: number;
}

/** Totais do período. Para consultor, restrito ao que é dele. */
export async function totaisGerais(
  db: Db, importId: string, agoraIso: string, consultorId: string | null,
): Promise<TotaisGerais> {
  const fa = filtroConsultor('consultor_id', consultorId);

  const acoes = await db.get<Record<string, number>>(
    `SELECT COUNT(*) AS acoes,
            COUNT(DISTINCT num_oportunidade) AS opps,
            SUM(CASE WHEN status_acao = 'Pendente' THEN 1 ELSE 0 END) AS pendentes,
            SUM(CASE WHEN status_acao = 'Pendente' AND dt_agendado IS NOT NULL
                      AND dt_agendado < ? THEN 1 ELSE 0 END) AS vencidas
       FROM acoes WHERE import_id = ?${fa.sql}`,
    [agoraIso, importId, ...fa.params],
  );

  const deg = await db.get<Record<string, number>>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'CANCELADO' THEN 1 ELSE 0 END) AS canceladas
       FROM degustacoes WHERE import_id = ?${fa.sql}`,
    [importId, ...fa.params],
  );

  // Faturamento: para consultor é o crédito dele; para gestor é o contrato
  // inteiro. As duas leituras são corretas — e diferentes — por construção.
  let contratos: number;
  let faturamentoC: number;
  let ticketC = 0;
  let descontoPct = 0;
  let abaixoMinimo = 0;

  if (consultorId) {
    const r = await db.get<Record<string, number>>(
      `SELECT COALESCE(SUM(quantidade),0) AS contratos, COALESCE(SUM(valor_c),0) AS valor_c
         FROM contrato_creditos WHERE import_id = ? AND consultor_id = ?`,
      [importId, consultorId],
    );
    contratos = Number(r?.['contratos'] ?? 0);
    faturamentoC = Number(r?.['valor_c'] ?? 0);
    ticketC = contratos > 0 ? faturamentoC / contratos : 0;
  } else {
    const r = await db.get<Record<string, number>>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(valor_ajustado_c),0) AS ajustado,
              COALESCE(SUM(valor_original_c),0) AS original,
              SUM(CASE WHEN valor_ajustado_c < valor_minimo_c THEN 1 ELSE 0 END) AS abaixo
         FROM contratos WHERE import_id = ?`,
      [importId],
    );
    contratos = Number(r?.['n'] ?? 0);
    faturamentoC = Number(r?.['ajustado'] ?? 0);
    const original = Number(r?.['original'] ?? 0);
    ticketC = contratos > 0 ? faturamentoC / contratos : 0;
    descontoPct = original > 0 ? ((original - faturamentoC) / original) * 100 : 0;
    abaixoMinimo = Number(r?.['abaixo'] ?? 0);
  }

  return {
    oportunidades: Number(acoes?.['opps'] ?? 0),
    acoes: Number(acoes?.['acoes'] ?? 0),
    pendentes: Number(acoes?.['pendentes'] ?? 0),
    vencidas: Number(acoes?.['vencidas'] ?? 0),
    degustacoes: Number(deg?.['total'] ?? 0),
    deg_canceladas: Number(deg?.['canceladas'] ?? 0),
    contratos,
    faturamento: paraReais(faturamentoC),
    ticket_medio: paraReais(Math.round(ticketC)),
    desconto_pct: Number(descontoPct.toFixed(2)),
    abaixo_minimo: abaixoMinimo,
  };
}

/** Distribuição de motivos de perda. */
export async function motivosPerda(
  db: Db, importId: string, consultorId: string | null,
): Promise<Array<{ motivo: string; total: number; evitavel: boolean }>> {
  const f = filtroConsultor('consultor_id', consultorId);
  const linhas = await db.all<{ acao: string; total: number }>(
    `SELECT acao, COUNT(DISTINCT num_oportunidade) AS total
       FROM acoes
      WHERE import_id = ? AND acao IN (${inLista(MOTIVOS_PERDA)})${f.sql}
      GROUP BY acao ORDER BY total DESC`,
    [importId, ...MOTIVOS_PERDA, ...f.params],
  );
  return linhas.map((l) => ({
    motivo: l.acao,
    total: Number(l.total),
    evitavel: MOTIVOS_EVITAVEIS.includes(l.acao),
  }));
}

// ---------------------------------------------------------------------------
// Listas nominais
// ---------------------------------------------------------------------------

export type TipoLista = 'vencidas' | 'aguardando' | 'sem_sucesso' | 'perdidos' | 'degustacoes' | 'contratos';

export interface ItemLista {
  chave: string;
  num_oportunidade: string | null;
  cliente: string | null;
  detalhe: string | null;
  tipo_evento: string | null;
  data_evento: string | null;
  referencia: string | null;
  dias: number | null;
  marcador: string | null;
  tratada: boolean;
  notas: number;
}

const LIMITE_PADRAO = 500;

/**
 * Lista nominal de clientes. Aqui trafega dado pessoal de terceiros, então:
 *   - o escopo do consultor é obrigatório no WHERE;
 *   - o acesso é auditado pela rota que chama esta função;
 *   - há teto de linhas, para que "exportar tudo" não seja um clique.
 */
export async function listaNominal(
  db: Db,
  importId: string,
  tipo: TipoLista,
  agoraIso: string,
  consultorId: string | null,
  limite = LIMITE_PADRAO,
): Promise<ItemLista[]> {
  const lim = Math.min(Math.max(1, limite), LIMITE_PADRAO);
  const fa = filtroConsultor('a.consultor_id', consultorId);
  const fd = filtroConsultor('d.consultor_id', consultorId);
  const fk = filtroConsultor('k.consultor_id', consultorId);

  let linhas: Array<Record<string, unknown>>;

  switch (tipo) {
    case 'vencidas':
      linhas = await db.all(
        `SELECT a.num_oportunidade, a.nome_cliente AS cliente, a.acao AS detalhe,
                a.tipo_evento, a.data_evento, a.dt_agendado AS referencia,
                a.consultor_id, a.linha
           FROM acoes a
          WHERE a.import_id = ? AND a.status_acao = 'Pendente'
            AND a.dt_agendado IS NOT NULL AND a.dt_agendado < ?${fa.sql}
          ORDER BY a.dt_agendado ASC LIMIT ?`,
        [importId, agoraIso, ...fa.params, lim],
      );
      break;

    case 'aguardando':
      linhas = await db.all(
        `SELECT a.num_oportunidade, a.nome_cliente AS cliente, a.origem AS detalhe,
                a.tipo_evento, a.data_evento, a.data_oportunidade AS referencia,
                a.consultor_id, a.linha
           FROM acoes a
          WHERE a.import_id = ? AND a.acao = 'CLIENTE AGUARDANDO 1º CONTATO'${fa.sql}
          GROUP BY a.num_oportunidade
          ORDER BY a.data_oportunidade ASC LIMIT ?`,
        [importId, ...fa.params, lim],
      );
      break;

    case 'sem_sucesso':
      linhas = await db.all(
        `SELECT a.num_oportunidade, a.nome_cliente AS cliente, a.origem AS detalhe,
                a.tipo_evento, a.data_evento, a.data_oportunidade AS referencia,
                a.consultor_id, a.linha
           FROM acoes a
          WHERE a.import_id = ? AND a.acao = '1º CONTATO - SEM SUCESSO'${fa.sql}
          GROUP BY a.num_oportunidade
          ORDER BY a.data_oportunidade ASC LIMIT ?`,
        [importId, ...fa.params, lim],
      );
      break;

    case 'perdidos':
      linhas = await db.all(
        `SELECT a.num_oportunidade, a.nome_cliente AS cliente, a.acao AS detalhe,
                a.tipo_evento, a.data_evento, a.data_oportunidade AS referencia,
                a.consultor_id, a.linha
           FROM acoes a
          WHERE a.import_id = ? AND a.acao IN (${inLista(MOTIVOS_PERDA)})${fa.sql}
          GROUP BY a.num_oportunidade
          ORDER BY a.acao ASC LIMIT ?`,
        [importId, ...MOTIVOS_PERDA, ...fa.params, lim],
      );
      break;

    case 'degustacoes':
      linhas = await db.all(
        `SELECT d.num_oportunidade, d.descricao AS cliente, d.casa_chegada AS detalhe,
                NULL AS tipo_evento, d.data_chegada AS data_evento,
                d.data_chegada AS referencia, d.status AS marcador,
                d.qtd_pessoas, d.consultor_id, d.codigo AS linha
           FROM degustacoes d
          WHERE d.import_id = ?${fd.sql}
          ORDER BY d.data_chegada ASC LIMIT ?`,
        [importId, ...fd.params, lim],
      );
      break;

    case 'contratos':
      linhas = await db.all(
        `SELECT NULL AS num_oportunidade, ct.descricao AS cliente, ct.casa AS detalhe,
                ct.tipo_evento, ct.data_evento, ct.num_contrato AS referencia,
                ct.status AS marcador, ct.pax,
                ${consultorId ? 'k.valor_c' : 'ct.valor_ajustado_c'} AS valor_c,
                k.quantidade, ct.num_contrato AS linha
           FROM contrato_creditos k
           JOIN contratos ct ON ct.id = k.contrato_id
          WHERE k.import_id = ?${fk.sql}
          ${consultorId ? '' : 'GROUP BY ct.id'}
          ORDER BY valor_c DESC LIMIT ?`,
        [importId, ...fk.params, lim],
      );
      break;
  }

  const nums = [...new Set(linhas.map((l) => l['num_oportunidade']).filter(Boolean))] as string[];
  const tratadas = new Set<string>();
  const contagemNotas = new Map<string, number>();

  if (nums.length > 0) {
    const ph = inLista(nums);
    for (const t of await db.all<{ num_oportunidade: string; chave_acao: string }>(
      `SELECT num_oportunidade, chave_acao FROM tratativas WHERE num_oportunidade IN (${ph})`, nums,
    )) tratadas.add(`${t.num_oportunidade}|${t.chave_acao}`);

    for (const n of await db.all<{ num_oportunidade: string; total: number }>(
      `SELECT num_oportunidade, COUNT(*) AS total FROM notas
        WHERE removido_em IS NULL AND num_oportunidade IN (${ph})
        GROUP BY num_oportunidade`, nums,
    )) contagemNotas.set(n.num_oportunidade, Number(n.total));
  }

  return linhas.map((l) => {
    const num = (l['num_oportunidade'] as string | null) ?? null;
    const chave = `${tipo}:${l['linha'] ?? ''}`;
    const ref = (l['referencia'] as string | null) ?? null;
    return {
      chave,
      num_oportunidade: num,
      cliente: (l['cliente'] as string | null) ?? null,
      detalhe: (l['detalhe'] as string | null) ?? null,
      tipo_evento: (l['tipo_evento'] as string | null) ?? null,
      data_evento: (l['data_evento'] as string | null) ?? null,
      referencia: l['valor_c'] !== undefined ? String(paraReais(Number(l['valor_c']))) : ref,
      dias: ref && tipo !== 'contratos'
        ? Math.floor((Date.parse(agoraIso) - Date.parse(ref)) / 86_400_000)
        : null,
      marcador: (l['marcador'] as string | null) ?? null,
      tratada: num ? tratadas.has(`${num}|${chave}`) : false,
      notas: num ? contagemNotas.get(num) ?? 0 : 0,
    };
  });
}

/** Confere se a oportunidade pertence ao consultor. Guarda das rotas de escrita. */
export async function oportunidadePertence(
  db: Db, importId: string, num: string, consultorId: string,
): Promise<boolean> {
  const r = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM acoes WHERE import_id = ? AND num_oportunidade = ? AND consultor_id = ?',
    [importId, num, consultorId],
  );
  return Number(r?.n ?? 0) > 0;
}
