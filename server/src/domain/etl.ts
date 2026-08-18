/**
 * ETL: das planilhas do CRM para o modelo normalizado.
 *
 * REGRA DE NEGÓCIO CRÍTICA — RATEIO DE VENDA
 * ------------------------------------------
 * O extrato de vendas exporta UMA LINHA POR CONSULTOR. Numa venda fechada a
 * quatro mãos, o mesmo contrato aparece duas vezes, cada linha com METADE do
 * valor e `Quantidade = 0,5`. Portanto:
 *
 *     valor do contrato      = SOMA das linhas daquele Num Contrato
 *     crédito de um consultor = a linha dele
 *     nº de contratos        = SOMA de Quantidade (0,5 + 0,5 = 1)
 *
 * Ler uma linha isolada como se fosse o contrato inteiro subestima o
 * faturamento pela metade; deduplicar por contrato e pegar uma linha só,
 * também. O caso que expõe o erro nos dados reais é o CT2026-0351: a linha
 * mostra R$ 28.548 (R$ 476/convidado, fora de qualquer padrão da casa),
 * enquanto o contrato é R$ 57.096 (R$ 952/convidado, coerente com as demais
 * vendas da Casa Lucca).
 *
 * `validarRateio()` verifica essa invariante em toda importação e recusa o
 * arquivo se ela não fechar.
 */

import { readXlsx, toRecords, type CellValue } from '../lib/xlsx.ts';
import {
  paraCentavos, paraIso, texto, textoUpper, inteiro, decimal, booleano, chaveNome,
} from '../lib/valores.ts';

export type Linha = Record<string, CellValue>;

export type TipoArquivo = 'oportunidades' | 'acoes' | 'degustacoes' | 'vendas';

/**
 * Assinatura de cada planilha: colunas obrigatórias e em que linha fica o
 * cabeçalho. Os relatórios em grade trazem título e descrição de filtro
 * antes do cabeçalho; o extrato de vendas começa direto no cabeçalho.
 */
export const ASSINATURAS: Record<TipoArquivo, { linhaCabecalho: number; obrigatorias: string[]; rotulo: string }> = {
  oportunidades: {
    linhaCabecalho: 2,
    rotulo: 'Oportunidades',
    obrigatorias: ['Num Oportunidade', 'Tipo Evento', 'Status', 'Data Oportunidade'],
  },
  acoes: {
    linhaCabecalho: 2,
    rotulo: 'Listagem de Ações',
    obrigatorias: ['Ação', 'Status Ação', 'Num Oportunidade', 'Responsável Ação'],
  },
  degustacoes: {
    linhaCabecalho: 2,
    rotulo: 'Degustações Comercial',
    obrigatorias: ['Codigo', 'Consultor', 'Status', 'Data Chegada'],
  },
  vendas: {
    linhaCabecalho: 0,
    rotulo: 'Extrato de Vendas',
    obrigatorias: ['Num Contrato', 'Valor Ajustado', 'Quantidade', 'Equipe'],
  },
};

export class ErroEtl extends Error {
  readonly detalhe: unknown;

  constructor(message: string, detalhe?: unknown) {
    super(message);
    this.name = 'ErroEtl';
    this.detalhe = detalhe;
  }
}

/**
 * Detecta o tipo do arquivo pelo cabeçalho, em vez de confiar no nome. O nome
 * do arquivo exportado muda a cada extração e o usuário pode renomear; o
 * conjunto de colunas, não.
 */
export function detectarTipo(buf: Buffer): { tipo: TipoArquivo; linhas: Linha[] } {
  const abas = readXlsx(buf);
  const aba = abas[0];
  if (!aba) throw new ErroEtl('A planilha não tem nenhuma aba legível.');

  const candidatos: Array<{ tipo: TipoArquivo; linhas: Linha[]; faltando: string[] }> = [];

  for (const [tipo, assin] of Object.entries(ASSINATURAS) as Array<[TipoArquivo, typeof ASSINATURAS[TipoArquivo]]>) {
    // Tolerância a uma linha de preâmbulo a mais ou a menos.
    for (const off of [0, 1, -1]) {
      const h = assin.linhaCabecalho + off;
      if (h < 0 || h >= aba.rows.length) continue;
      const linhas = toRecords(aba.rows, h);
      const cols = new Set(Object.keys(linhas[0] ?? {}));
      const faltando = assin.obrigatorias.filter((c) => !cols.has(c));
      if (faltando.length === 0) return { tipo, linhas };
      candidatos.push({ tipo, linhas, faltando });
    }
  }

  const melhor = candidatos.sort((a, b) => a.faltando.length - b.faltando.length)[0];
  throw new ErroEtl(
    'Não reconheci esta planilha. Confira se a exportação do CRM está completa.',
    melhor
      ? {
          suposicao: ASSINATURAS[melhor.tipo].rotulo,
          colunasFaltando: melhor.faltando,
          colunasEncontradas: Object.keys(melhor.linhas[0] ?? {}).slice(0, 25),
        }
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Registros normalizados
// ---------------------------------------------------------------------------

export interface Oportunidade {
  num: string; descricao: string | null; contato: string | null;
  tipo_evento: string | null; origem: string | null; data_evento: string | null;
  pax: number | null; status: string | null; data_oportunidade: string | null;
  proxima_acao: string | null; ultima_acao: string | null; ult_acao: string | null;
}

export interface Acao {
  num_oportunidade: string; acao: string; status_acao: string;
  num_cliente: string | null; nome_cliente: string | null; data_evento: string | null;
  tipo_evento: string | null; data_oportunidade: string | null; origem: string | null;
  status_oportunidade: string | null; consultorNome: string | null;
  dt_agendado: string | null; presencial: 0 | 1; linha: number;
}

export interface Degustacao {
  codigo: string | null; num_oportunidade: string | null; descricao: string | null;
  qtd_pessoas: number | null; data_chegada: string | null; casa_chegada: string | null;
  consultorNome: string | null; casas_vista: string | null; casa_degustacao: string | null;
  horario: string | null; status: string | null;
}

export interface LinhaVenda {
  num_contrato: string; id_evento: string | null; descricao: string | null;
  contratante: string | null; casa: string | null; tipo_evento: string | null;
  data_evento: string | null; pax: number | null;
  valor_minimo_c: number; valor_original_c: number; valor_ajustado_c: number;
  status: string | null; fechamento: string | null;
  consultorNome: string | null; quantidade: number;
}

export interface Contrato {
  num_contrato: string; id_evento: string | null; descricao: string | null;
  contratante: string | null; casa: string | null; tipo_evento: string | null;
  data_evento: string | null; pax: number | null;
  valor_minimo_c: number; valor_original_c: number; valor_ajustado_c: number;
  status: string | null; fechamento: string | null; partes: number;
  creditos: Array<{ consultorNome: string | null; quantidade: number; valor_c: number }>;
}

// ---------------------------------------------------------------------------
// Normalizadores
// ---------------------------------------------------------------------------

/** Linhas de rodapé ("Total", "Filtros aplicados:") não são dados. */
function ehRodape(v: unknown): boolean {
  const s = texto(v)?.toLowerCase() ?? '';
  return s === '' || s === 'total' || s.startsWith('filtros aplicados');
}

export function normalizarOportunidades(linhas: Linha[]): Oportunidade[] {
  const out: Oportunidade[] = [];
  for (const l of linhas) {
    const num = texto(l['Num Oportunidade']);
    if (!num || ehRodape(num)) continue;
    out.push({
      num,
      descricao: texto(l['Desc Oportunidade']),
      contato: texto(l['Contato Principal']),
      tipo_evento: textoUpper(l['Tipo Evento']),
      origem: textoUpper(l['Origem']),
      data_evento: paraIso(l['Data Evento']),
      pax: inteiro(l['Pax']),
      status: texto(l['Status']),
      data_oportunidade: paraIso(l['Data Oportunidade']),
      proxima_acao: paraIso(l['Próxima Ação']),
      ultima_acao: paraIso(l['Última Ação']),
      ult_acao: textoUpper(l['Ult Ação']),
    });
  }
  return out;
}

export function normalizarAcoes(linhas: Linha[]): Acao[] {
  const out: Acao[] = [];
  let i = 0;
  for (const l of linhas) {
    const num = texto(l['Num Oportunidade']);
    const acao = textoUpper(l['Ação']);
    if (!num || !acao || ehRodape(num)) continue;
    out.push({
      num_oportunidade: num,
      acao,
      status_acao: texto(l['Status Ação']) ?? 'Pendente',
      num_cliente: texto(l['Num Cliente']),
      nome_cliente: texto(l['Nome']),
      data_evento: paraIso(l['Data Evento']),
      tipo_evento: textoUpper(l['Tipo Evento']),
      data_oportunidade: paraIso(l['Data Oportunidade']),
      origem: textoUpper(l['Origem']),
      status_oportunidade: texto(l['Status Oportunidade']),
      consultorNome: texto(l['Responsável Ação']),
      dt_agendado: paraIso(l['dt Agendado']),
      presencial: booleano(l['Presencial']),
      linha: i++,
    });
  }
  return out;
}

export function normalizarDegustacoes(linhas: Linha[]): Degustacao[] {
  const out: Degustacao[] = [];
  for (const l of linhas) {
    const cod = texto(l['Codigo']);
    if (!cod || ehRodape(cod)) continue;
    out.push({
      codigo: cod,
      num_oportunidade: texto(l['Num Oportunidade']),
      descricao: texto(l['Oportunidade Descrição']),
      qtd_pessoas: inteiro(l['Quantidade Pessoas']),
      data_chegada: paraIso(l['Data Chegada']),
      casa_chegada: textoUpper(l['Casas Chegada Casa']),
      consultorNome: texto(l['Consultor']),
      casas_vista: texto(l['Casas Vista']),
      casa_degustacao: textoUpper(l['Casa Degustacao Casa']),
      horario: paraIso(l['Horario Degustacao']),
      status: textoUpper(l['Status']),
    });
  }
  return out;
}

export function normalizarVendas(linhas: Linha[]): LinhaVenda[] {
  const out: LinhaVenda[] = [];
  for (const l of linhas) {
    const num = texto(l['Num Contrato']);
    // O rodapé "Total" desloca as colunas: 'Num Contrato' vem numérico ali.
    if (!num || ehRodape(num) || typeof l['Num Contrato'] === 'number') continue;

    const q = decimal(l['Quantidade']);
    out.push({
      num_contrato: num,
      id_evento: texto(l['idEvento']),
      descricao: texto(l['Descricao']),
      contratante: texto(l['Contratante']),
      casa: textoUpper(l['Casa']),
      tipo_evento: textoUpper(l['Tipo Evento']),
      data_evento: paraIso(l['Data Evento']),
      pax: inteiro(l['Pax']),
      valor_minimo_c: paraCentavos(decimal(l['Valor Minimo'])),
      valor_original_c: paraCentavos(decimal(l['Valor Original'])),
      valor_ajustado_c: paraCentavos(decimal(l['Valor Ajustado'])),
      status: texto(l['Status']),
      fechamento: texto(l['Fechamento']),
      consultorNome: texto(l['Equipe']),
      quantidade: q === null || q <= 0 ? 1 : q,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Consolidação de contratos (a regra de rateio)
// ---------------------------------------------------------------------------

export function consolidarContratos(linhas: LinhaVenda[]): Contrato[] {
  const mapa = new Map<string, Contrato>();

  for (const l of linhas) {
    let c = mapa.get(l.num_contrato);
    if (!c) {
      c = {
        num_contrato: l.num_contrato,
        id_evento: l.id_evento,
        descricao: l.descricao,
        contratante: l.contratante,
        casa: l.casa,
        tipo_evento: l.tipo_evento,
        data_evento: l.data_evento,
        pax: l.pax,
        valor_minimo_c: 0,
        valor_original_c: 0,
        valor_ajustado_c: 0,
        status: l.status,
        fechamento: l.fechamento,
        partes: 0,
        creditos: [],
      };
      mapa.set(l.num_contrato, c);
    }
    // Somar é o ponto inteiro desta função: cada linha é uma parte do contrato.
    c.valor_minimo_c += l.valor_minimo_c;
    c.valor_original_c += l.valor_original_c;
    c.valor_ajustado_c += l.valor_ajustado_c;
    c.partes += 1;
    // Descrição e contratante às vezes só vêm preenchidos em uma das linhas.
    c.descricao ??= l.descricao;
    c.contratante ??= l.contratante;
    c.creditos.push({
      consultorNome: l.consultorNome,
      quantidade: l.quantidade,
      valor_c: l.valor_ajustado_c,
    });
  }

  return [...mapa.values()];
}

export interface ProblemaRateio {
  num_contrato: string;
  problema: string;
  quantidadeSomada: number;
  partes: number;
}

/**
 * Invariante: a soma de `Quantidade` das linhas de um contrato deve ser 1.
 * Se não for, ou o CRM mudou o formato de exportação, ou a extração veio
 * incompleta (uma das metades ficou de fora). Nos dois casos o faturamento
 * sairia errado, então a importação é recusada em vez de gravar dado torto.
 */
export function validarRateio(contratos: Contrato[]): ProblemaRateio[] {
  const problemas: ProblemaRateio[] = [];
  for (const c of contratos) {
    const soma = c.creditos.reduce((a, x) => a + x.quantidade, 0);
    if (Math.abs(soma - 1) > 0.001) {
      problemas.push({
        num_contrato: c.num_contrato,
        problema:
          soma < 1
            ? `Soma das partes é ${soma} (esperado 1). Provável linha faltando na exportação.`
            : `Soma das partes é ${soma} (esperado 1). Provável linha duplicada na exportação.`,
        quantidadeSomada: soma,
        partes: c.partes,
      });
    }
  }
  return problemas;
}

/** Total de contratos do período: soma das quantidades, não contagem de linhas. */
export function totalContratos(contratos: Contrato[]): number {
  return contratos.reduce((a, c) => a + c.creditos.reduce((b, x) => b + x.quantidade, 0), 0);
}

/** Faturamento do período em centavos. */
export function faturamentoCentavos(contratos: Contrato[]): number {
  return contratos.reduce((a, c) => a + c.valor_ajustado_c, 0);
}

// ---------------------------------------------------------------------------
// Consultores
// ---------------------------------------------------------------------------

/**
 * Reúne os nomes de consultor que aparecem em qualquer das planilhas.
 * A chave canônica (sem acento, caixa baixa) evita cadastrar "Lívia" e
 * "Livia" como duas pessoas; guardamos a grafia mais completa encontrada.
 */
export function coletarConsultores(
  acoes: Acao[], degustacoes: Degustacao[], vendas: LinhaVenda[],
): Map<string, string> {
  const mapa = new Map<string, string>();
  const add = (nome: string | null) => {
    if (!nome) return;
    const k = chaveNome(nome);
    if (!k) return;
    const atual = mapa.get(k);
    // Mantém a grafia com mais caracteres (normalmente a acentuada e completa).
    if (!atual || nome.length > atual.length) mapa.set(k, nome);
  };
  for (const a of acoes) add(a.consultorNome);
  for (const d of degustacoes) add(d.consultorNome);
  for (const v of vendas) add(v.consultorNome);
  return mapa;
}
