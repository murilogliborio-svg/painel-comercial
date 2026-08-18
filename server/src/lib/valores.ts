/**
 * Dinheiro, datas e normalização de texto.
 *
 * DINHEIRO
 * --------
 * Todo valor monetário circula e é gravado como INTEGER de centavos.
 * Motivo concreto, observado nos dados reais deste projeto: a planilha de
 * vendas traz `80507.00000000001` e `90349.165`. Somar 13 desses em ponto
 * flutuante produz um total que não fecha com o relatório. Em centavos, a
 * soma é exata e o total confere na casa decimal.
 *
 * A conversão acontece uma única vez, na borda de entrada (ETL), e a volta
 * acontece na borda de saída (JSON da API). No meio, nunca há float.
 */

/** Converte um valor da planilha para centavos. Arredonda meio para cima. */
export function paraCentavos(valor: number | string | null | undefined): number {
  if (valor === null || valor === undefined || valor === '') return 0;
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  // Multiplica antes de arredondar; o epsilon absorve o erro de representação
  // binária de valores como 80507.00000000001 sem alterar valores legítimos.
  return Math.round(n * 100 + (n >= 0 ? Number.EPSILON : -Number.EPSILON) * 100);
}

/** Converte centavos para número com 2 casas, para serialização em JSON. */
export function paraReais(centavos: number): number {
  return Math.round(centavos) / 100;
}

/** Formata centavos em moeda brasileira. Uso em relatórios e logs. */
export function formatBRL(centavos: number): string {
  return (Math.round(centavos) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

/**
 * Interpreta os formatos que os exportadores do CRM produzem:
 *   - "17/08/2026"            (dd/mm/aaaa)
 *   - "17/08/2026 14:30"      (dd/mm/aaaa hh:mm)
 *   - "17/08/2026 14:30:05"
 *   - Date                     (célula com formato de data no XLSX)
 *   - "2026-08-17T00:00:00Z"  (ISO, caso a origem mude)
 *
 * Retorna ISO-8601 UTC ou null. Datas sem hora viram meia-noite UTC — a
 * comparação no sistema é sempre por dia, então não há ambiguidade de fuso.
 */
export function paraIso(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return null;

  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
  }

  if (typeof valor === 'number') {
    // Serial do Excel; o leitor XLSX já converte quando o estilo é de data,
    // então aqui só chega número quando a coluna não tem formato de data.
    return null;
  }

  const s = String(valor).trim();
  if (!s) return null;

  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (br) {
    const [, d, m, a, hh, mm, ss] = br;
    const dt = new Date(Date.UTC(+a!, +m! - 1, +d!, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)));
    // Rejeita datas impossíveis que o Date "conserta" silenciosamente
    // (31/02 viraria 03/03 sem esta checagem).
    if (dt.getUTCDate() !== +d! || dt.getUTCMonth() !== +m! - 1) return null;
    return dt.toISOString();
  }

  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** Recorta um ISO para o dia (YYYY-MM-DD). Útil em agrupamento e comparação. */
export function dia(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** Diferença em dias inteiros entre dois ISO (b - a). */
export function diasEntre(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/**
 * Normaliza texto vindo da planilha: colapsa espaços internos (o CRM exporta
 * "BERNARDO    RODRIGUES") e devolve null para vazio, para que a ausência de
 * dado seja NULL no banco e não string vazia — a diferença importa nas
 * métricas de preenchimento.
 */
export function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Igual a `texto`, mas em caixa alta. Para campos categóricos (casa, status). */
export function textoUpper(valor: unknown): string | null {
  const s = texto(valor);
  return s === null ? null : s.toLocaleUpperCase('pt-BR');
}

/** Converte para inteiro ou null. */
export function inteiro(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Converte para número decimal ou null (usado só em quantidade de rateio). */
export function decimal(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "Yes"/"Sim"/"1"/true -> 1, caso contrário 0. */
export function booleano(valor: unknown): 0 | 1 {
  if (valor === true) return 1;
  const s = texto(valor)?.toLowerCase();
  return s === 'yes' || s === 'sim' || s === 'true' || s === '1' ? 1 : 0;
}

/**
 * Chave canônica de nome de pessoa: sem acento, sem pontuação, caixa baixa,
 * espaços colapsados. Usada para casar "Livia Beanuci Fernandes" da planilha
 * de ações com "Lívia Beanuci Fernandes" da planilha de degustações sem
 * criar dois consultores diferentes.
 */
export function chaveNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marcas diacríticas combinantes
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
