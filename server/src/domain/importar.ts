/**
 * Persistência de uma importação.
 *
 * FLUXO EM DUAS FASES
 * -------------------
 *   1. `prepararImportacao` grava tudo com status 'rascunho' e devolve as
 *      estatísticas e divergências. Nada muda para os usuários ainda.
 *   2. `confirmarImportacao` promove o rascunho a base ativa, dentro de uma
 *      transação. `reverterImportacao` volta para a anterior.
 *
 * O gestor vê o que vai mudar antes de mudar. Importação que sobrescreve a
 * base sem prévia é como deploy sem staging: funciona até o dia em que a
 * exportação vem truncada e ninguém percebe por uma semana.
 *
 * Importações antigas são preservadas, o que dá histórico entre períodos e
 * torna a reversão trivial (é só trocar qual id está ativo).
 */

import type { Db } from '../db/index.ts';
import { ulid } from '../lib/ids.ts';
import { chaveNome } from '../lib/valores.ts';
import {
  detectarTipo, normalizarOportunidades, normalizarAcoes, normalizarDegustacoes,
  normalizarVendas, consolidarContratos, validarRateio, coletarConsultores,
  totalContratos, faturamentoCentavos, ErroEtl,
  type TipoArquivo, type ProblemaRateio,
} from './etl.ts';

export const CHAVE_IMPORTACAO_ATIVA = 'importacao_ativa';

export interface ArquivoEnviado {
  nome: string;
  bytes: Buffer;
}

export interface EstatisticasImportacao {
  oportunidades: number;
  acoes: number;
  degustacoes: number;
  linhasVenda: number;
  contratos: number;
  totalContratos: number;
  faturamentoCentavos: number;
  consultores: number;
  periodoIni: string | null;
  periodoFim: string | null;
}

export interface ResultadoPreparo {
  importId: string;
  estatisticas: EstatisticasImportacao;
  problemasRateio: ProblemaRateio[];
  arquivos: Array<{ nome: string; tipo: TipoArquivo; registros: number }>;
  comparacao: Comparacao | null;
  novosConsultores: string[];
}

export interface Comparacao {
  importAnteriorId: string;
  delta: Record<string, { antes: number; agora: number; variacao: number }>;
  alertas: string[];
}

export async function importacaoAtiva(db: Db): Promise<string | null> {
  const r = await db.get<{ valor: string }>('SELECT valor FROM configuracoes WHERE chave = ?', [
    CHAVE_IMPORTACAO_ATIVA,
  ]);
  return r?.valor ?? null;
}

async function definirAtiva(db: Db, id: string): Promise<void> {
  const agora = new Date().toISOString();
  const existe = await db.get('SELECT chave FROM configuracoes WHERE chave = ?', [CHAVE_IMPORTACAO_ATIVA]);
  if (existe) {
    await db.run('UPDATE configuracoes SET valor = ?, atualizado_em = ? WHERE chave = ?', [
      id, agora, CHAVE_IMPORTACAO_ATIVA,
    ]);
  } else {
    await db.run('INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES (?, ?, ?)', [
      CHAVE_IMPORTACAO_ATIVA, id, agora,
    ]);
  }
}

/** Cadastra consultores que ainda não existem, casando por chave canônica. */
async function garantirConsultores(db: Db, nomes: Map<string, string>): Promise<{
  porChave: Map<string, string>;
  novos: string[];
}> {
  const existentes = await db.all<{ id: string; nome: string }>('SELECT id, nome FROM consultores');
  const porChave = new Map<string, string>();
  for (const c of existentes) porChave.set(chaveNome(c.nome), c.id);

  const novos: string[] = [];
  for (const [chave, nome] of nomes) {
    if (porChave.has(chave)) continue;
    const id = ulid();
    await db.run('INSERT INTO consultores (id, nome, ativo, criado_em) VALUES (?, ?, 1, ?)', [
      id, nome, new Date().toISOString(),
    ]);
    porChave.set(chave, id);
    novos.push(nome);
  }
  return { porChave, novos };
}

function minMax(datas: Array<string | null>): [string | null, string | null] {
  const v = datas.filter((d): d is string => !!d).sort();
  return [v[0] ?? null, v[v.length - 1] ?? null];
}

export async function prepararImportacao(
  db: Db,
  arquivos: ArquivoEnviado[],
  usuarioId: string,
  observacao: string | null = null,
): Promise<ResultadoPreparo> {
  if (arquivos.length === 0) throw new ErroEtl('Nenhum arquivo enviado.');

  // --- parse e classificação ---
  const porTipo = new Map<TipoArquivo, { nome: string; linhas: ReturnType<typeof detectarTipo>['linhas'] }>();
  const resumoArquivos: ResultadoPreparo['arquivos'] = [];

  for (const a of arquivos) {
    const { tipo, linhas } = detectarTipo(a.bytes);
    if (porTipo.has(tipo)) {
      throw new ErroEtl(
        `Dois arquivos foram reconhecidos como "${tipo}": "${porTipo.get(tipo)!.nome}" e "${a.nome}". ` +
        'Envie um arquivo de cada tipo.',
      );
    }
    porTipo.set(tipo, { nome: a.nome, linhas });
    resumoArquivos.push({ nome: a.nome, tipo, registros: linhas.length });
  }

  const faltando = (['oportunidades', 'acoes', 'degustacoes', 'vendas'] as TipoArquivo[])
    .filter((t) => !porTipo.has(t));
  if (faltando.length) {
    throw new ErroEtl(
      `Faltam planilhas para completar a importação: ${faltando.join(', ')}. ` +
      'A base precisa dos quatro relatórios do mesmo período.',
    );
  }

  const oportunidades = normalizarOportunidades(porTipo.get('oportunidades')!.linhas);
  const acoes = normalizarAcoes(porTipo.get('acoes')!.linhas);
  const degustacoes = normalizarDegustacoes(porTipo.get('degustacoes')!.linhas);
  const linhasVenda = normalizarVendas(porTipo.get('vendas')!.linhas);
  const contratos = consolidarContratos(linhasVenda);

  // Invariante do rateio: recusa antes de gravar qualquer coisa.
  const problemasRateio = validarRateio(contratos);
  if (problemasRateio.length > 0) {
    throw new ErroEtl(
      'O rateio das vendas não fecha e a importação foi recusada para não gravar ' +
      'faturamento incorreto. Reexporte o extrato de vendas do CRM sem filtro de vendedor.',
      { problemas: problemasRateio },
    );
  }

  const [periodoIni, periodoFim] = minMax(oportunidades.map((o) => o.data_oportunidade));

  const estatisticas: EstatisticasImportacao = {
    oportunidades: oportunidades.length,
    acoes: acoes.length,
    degustacoes: degustacoes.length,
    linhasVenda: linhasVenda.length,
    contratos: contratos.length,
    totalContratos: totalContratos(contratos),
    faturamentoCentavos: faturamentoCentavos(contratos),
    consultores: 0,
    periodoIni,
    periodoFim,
  };

  const importId = ulid();

  const novosConsultores = await db.tx(async (t) => {
    const nomes = coletarConsultores(acoes, degustacoes, linhasVenda);
    const { porChave, novos } = await garantirConsultores(t, nomes);
    estatisticas.consultores = nomes.size;

    await t.run(
      `INSERT INTO importacoes
         (id, criado_por, status, periodo_ini, periodo_fim, arquivos, estatisticas, observacao, criado_em)
       VALUES (?, ?, 'rascunho', ?, ?, ?, ?, ?, ?)`,
      [
        importId, usuarioId, periodoIni, periodoFim,
        JSON.stringify(resumoArquivos), JSON.stringify(estatisticas),
        observacao, new Date().toISOString(),
      ],
    );

    const idDe = (nome: string | null): string | null =>
      nome ? porChave.get(chaveNome(nome)) ?? null : null;

    for (const o of oportunidades) {
      await t.run(
        `INSERT INTO oportunidades
           (id, import_id, num, descricao, contato, tipo_evento, origem, data_evento, pax,
            status, data_oportunidade, proxima_acao, ultima_acao, ult_acao)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ulid(), importId, o.num, o.descricao, o.contato, o.tipo_evento, o.origem,
         o.data_evento, o.pax, o.status, o.data_oportunidade, o.proxima_acao, o.ultima_acao, o.ult_acao],
      );
    }

    for (const a of acoes) {
      await t.run(
        `INSERT INTO acoes
           (id, import_id, num_oportunidade, acao, status_acao, num_cliente, nome_cliente,
            data_evento, tipo_evento, data_oportunidade, origem, status_oportunidade,
            consultor_id, dt_agendado, presencial, linha)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ulid(), importId, a.num_oportunidade, a.acao, a.status_acao, a.num_cliente, a.nome_cliente,
         a.data_evento, a.tipo_evento, a.data_oportunidade, a.origem, a.status_oportunidade,
         idDe(a.consultorNome), a.dt_agendado, a.presencial, a.linha],
      );
    }

    for (const d of degustacoes) {
      await t.run(
        `INSERT INTO degustacoes
           (id, import_id, codigo, num_oportunidade, descricao, qtd_pessoas, data_chegada,
            casa_chegada, consultor_id, casas_vista, casa_degustacao, horario, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ulid(), importId, d.codigo, d.num_oportunidade, d.descricao, d.qtd_pessoas, d.data_chegada,
         d.casa_chegada, idDe(d.consultorNome), d.casas_vista, d.casa_degustacao, d.horario, d.status],
      );
    }

    for (const c of contratos) {
      const contratoId = ulid();
      await t.run(
        `INSERT INTO contratos
           (id, import_id, num_contrato, id_evento, descricao, contratante, casa, tipo_evento,
            data_evento, pax, valor_minimo_c, valor_original_c, valor_ajustado_c, status,
            fechamento, partes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [contratoId, importId, c.num_contrato, c.id_evento, c.descricao, c.contratante, c.casa,
         c.tipo_evento, c.data_evento, c.pax, c.valor_minimo_c, c.valor_original_c,
         c.valor_ajustado_c, c.status, c.fechamento, c.partes],
      );
      for (const k of c.creditos) {
        await t.run(
          `INSERT INTO contrato_creditos (id, import_id, contrato_id, consultor_id, quantidade, valor_c)
           VALUES (?,?,?,?,?,?)`,
          [ulid(), importId, contratoId, idDe(k.consultorNome), k.quantidade, k.valor_c],
        );
      }
    }

    return novos;
  });

  const comparacao = await compararComAtiva(db, importId, estatisticas);

  return { importId, estatisticas, problemasRateio, arquivos: resumoArquivos, comparacao, novosConsultores };
}

/**
 * Compara o rascunho com a base ativa e levanta alertas para variações que
 * costumam indicar exportação incompleta e não mudança real do negócio.
 */
async function compararComAtiva(
  db: Db, _novoId: string, nova: EstatisticasImportacao,
): Promise<Comparacao | null> {
  const ativaId = await importacaoAtiva(db);
  if (!ativaId) return null;

  const r = await db.get<{ estatisticas: string }>(
    'SELECT estatisticas FROM importacoes WHERE id = ?', [ativaId],
  );
  if (!r) return null;

  const antes = JSON.parse(r.estatisticas) as EstatisticasImportacao;
  const campos: Array<keyof EstatisticasImportacao> = [
    'oportunidades', 'acoes', 'degustacoes', 'contratos', 'totalContratos', 'faturamentoCentavos',
  ];

  const delta: Comparacao['delta'] = {};
  const alertas: string[] = [];

  for (const c of campos) {
    const a = Number(antes[c] ?? 0);
    const b = Number(nova[c] ?? 0);
    const variacao = a === 0 ? (b === 0 ? 0 : 1) : (b - a) / a;
    delta[c] = { antes: a, agora: b, variacao };
    if (a > 0 && variacao <= -0.5) {
      alertas.push(
        `"${c}" caiu ${Math.round(Math.abs(variacao) * 100)}% em relação à base atual ` +
        `(${a} → ${b}). Confirme se a exportação cobre o período inteiro.`,
      );
    }
  }
  if (nova.contratos === 0 && antes.contratos > 0) {
    alertas.push('A nova base não tem nenhum contrato. O extrato de vendas provavelmente veio vazio.');
  }

  return { importAnteriorId: ativaId, delta, alertas };
}

export async function confirmarImportacao(db: Db, importId: string): Promise<void> {
  await db.tx(async (t) => {
    const imp = await t.get<{ status: string }>('SELECT status FROM importacoes WHERE id = ?', [importId]);
    if (!imp) throw new ErroEtl('Importação não encontrada.');
    if (imp.status !== 'rascunho') {
      throw new ErroEtl(`Só é possível confirmar uma importação em rascunho (esta está "${imp.status}").`);
    }
    await t.run('UPDATE importacoes SET status = ?, confirmado_em = ? WHERE id = ?', [
      'confirmada', new Date().toISOString(), importId,
    ]);
    await definirAtiva(t, importId);
  });
}

/** Volta a base ativa para a importação confirmada imediatamente anterior. */
export async function reverterImportacao(db: Db, importId: string): Promise<string | null> {
  return db.tx(async (t) => {
    const anterior = await t.get<{ id: string }>(
      `SELECT id FROM importacoes
        WHERE status = 'confirmada' AND id < ?
        ORDER BY id DESC LIMIT 1`,
      [importId],
    );
    await t.run('UPDATE importacoes SET status = ?, revertido_em = ? WHERE id = ?', [
      'revertida', new Date().toISOString(), importId,
    ]);
    if (anterior) await definirAtiva(t, anterior.id);
    else await t.run('DELETE FROM configuracoes WHERE chave = ?', [CHAVE_IMPORTACAO_ATIVA]);
    return anterior?.id ?? null;
  });
}

/** Remove um rascunho não confirmado e todos os seus dados. */
export async function descartarImportacao(db: Db, importId: string): Promise<void> {
  const imp = await db.get<{ status: string }>('SELECT status FROM importacoes WHERE id = ?', [importId]);
  if (!imp) throw new ErroEtl('Importação não encontrada.');
  if (imp.status === 'confirmada') throw new ErroEtl('Uma importação confirmada não pode ser descartada; reverta-a.');
  // As FK são ON DELETE CASCADE: apagar a importação leva os dados junto.
  await db.run('DELETE FROM importacoes WHERE id = ?', [importId]);
}
