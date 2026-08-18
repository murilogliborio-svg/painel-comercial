/**
 * Leitor XLSX sem dependências externas.
 *
 * Um .xlsx é um container ZIP com XML dentro. Este módulo implementa o mínimo
 * necessário para ler planilhas geradas por sistemas de CRM/ERP:
 *
 *   1. Leitura do diretório central do ZIP e inflate dos membros (node:zlib).
 *   2. Parse de xl/sharedStrings.xml (tabela de strings compartilhadas).
 *   3. Parse de xl/workbook.xml + rels (nomes e ordem das abas).
 *   4. Parse de xl/worksheets/sheetN.xml em matriz de células.
 *   5. Conversão de serial de data do Excel para Date (epoch 1900, com o
 *      bug histórico do ano bissexto de 1900 preservado, como faz o Excel).
 *
 * Escopo deliberadamente restrito: leitura. Não escreve, não avalia fórmulas
 * (lê o valor cacheado), não interpreta estilos além do formato numérico
 * necessário para distinguir data de número.
 */

import { inflateRawSync } from 'node:zlib';

export type CellValue = string | number | boolean | Date | null;

export interface Sheet {
  name: string;
  rows: CellValue[][];
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Localiza o End Of Central Directory, varrendo de trás para frente. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new XlsxError('Arquivo não é um ZIP válido: EOCD não encontrado.');
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: quando os campos de 32 bits estouram, o valor real está no
  // registro ZIP64 apontado pelo locator imediatamente antes do EOCD.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) === SIG_EOCD64) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new XlsxError(`Cabeçalho local inválido para "${entry.name}".`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return inflateRawSync(raw);
  throw new XlsxError(`Método de compressão ${entry.compressionMethod} não suportado.`);
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent] ?? whole;
  });
}

/** Extrai o valor de um atributo de uma tag já isolada. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? decodeXml(m[1]!) : null;
}

/**
 * Prefixo de namespace opcional. Exportadores diferentes escrevem `<sheet>`,
 * `<x:sheet>` ou `<ss:sheet>` para o mesmo elemento; o parser precisa aceitar
 * as três formas. (O CRM que gera `data13.xlsx` usa prefixo `x:`.)
 */
const NS = '(?:[A-Za-z_][\\w.\\-]*:)?';

/** Regex para o par <nome ...> ... </nome>, com prefixo de namespace opcional. */
function pairRe(name: string, flags = ''): RegExp {
  return new RegExp(`<${NS}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${NS}${name}>`, flags);
}

/**
 * Retorna as tags de abertura de um elemento, cobrindo as duas formas que os
 * geradores usam na prática: `<sheet .../>` e `<sheet ...></sheet>`.
 * O lookahead evita casar com a tag de fechamento `</sheet>`.
 */
function openTags(xml: string, name: string): string[] {
  const re = new RegExp(`<${NS}${name}(?=[\\s/>])[^>]*>`, 'g');
  return xml.match(re) ?? [];
}

/**
 * Concatena o texto de todos os elementos <t> dentro de um trecho, ignorando
 * anotações fonéticas (<rPh>) que o Excel adiciona em textos asiáticos.
 */
function textOfT(xml: string): string {
  let out = '';
  const re = pairRe('t', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out += decodeXml(m[1] ?? '');
  return out;
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const MS_DAY = 86400000;
/** 1899-12-30 UTC: origem que compensa o bug do ano bissexto de 1900. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function serialToDate(serial: number): Date {
  // Seriais são contados em dias; a fração representa a hora do dia.
  // Arredondamos para o segundo para evitar 09:59:59.9999 vindo de float.
  const ms = Math.round(serial * MS_DAY * 1000) / 1000;
  return new Date(EXCEL_EPOCH + Math.round(ms));
}

/** Formatos numéricos embutidos do Excel que representam data ou hora. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function formatIsDate(code: string | null, numFmtId: number): boolean {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  if (!code) return false;
  // Remove literais entre aspas e colchetes antes de procurar tokens de data.
  const cleaned = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[yYmMdDhHsS]/.test(cleaned) && /[yYdDhHsS]/.test(cleaned);
}

// ---------------------------------------------------------------------------
// Endereços de célula
// ---------------------------------------------------------------------------

/** "BC12" -> 54 (índice de coluna base zero). */
export function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// ---------------------------------------------------------------------------
// Erro tipado
// ---------------------------------------------------------------------------

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /** Limite de linhas por aba, proteção contra arquivo malicioso. Padrão 200.000. */
  maxRows?: number;
  /** Limite de colunas por linha. Padrão 512. */
  maxCols?: number;
}

export function readXlsx(buf: Buffer, opts: ReadOptions = {}): Sheet[] {
  const maxRows = opts.maxRows ?? 200_000;
  const maxCols = opts.maxCols ?? 512;

  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string): string | null => {
    const e = byName.get(name);
    return e ? extract(buf, e).toString('utf8') : null;
  };

  // --- strings compartilhadas ---
  const shared: string[] = [];
  const sst = read('xl/sharedStrings.xml');
  if (sst) {
    const re = pairRe('si', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sst)) !== null) shared.push(textOfT(m[1] ?? ''));
  }

  // --- estilos: mapa xf -> é data? ---
  const isDateStyle: boolean[] = [];
  const styles = read('xl/styles.xml');
  if (styles) {
    const custom = new Map<number, string>();
    for (const tag of openTags(styles, 'numFmt')) {
      const id = Number(attr(tag, 'numFmtId'));
      const code = attr(tag, 'formatCode');
      if (Number.isFinite(id) && code !== null) custom.set(id, code);
    }
    // Apenas o bloco cellXfs descreve os estilos aplicados às células.
    const cellXfs = pairRe('cellXfs').exec(styles)?.[0] ?? '';
    for (const tag of openTags(cellXfs, 'xf')) {
      const id = Number(attr(tag, 'numFmtId') ?? '0');
      isDateStyle.push(formatIsDate(custom.get(id) ?? null, id));
    }
  }

  // --- abas: nome + rId -> alvo ---
  const relsXml = read('xl/_rels/workbook.xml.rels') ?? '';
  const relTarget = new Map<string, string>();
  {
    for (const tag of openTags(relsXml, 'Relationship')) {
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
  }

  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new XlsxError('xl/workbook.xml ausente: arquivo não é um XLSX.');

  const sheets: Sheet[] = [];
  let fallbackIndex = 0;
  // <sheets> pode conter <sheet> aninhado; restringimos ao bloco correto.
  const sheetsBlock = pairRe('sheets').exec(workbook)?.[0] ?? workbook;
  for (const tag of openTags(sheetsBlock, 'sheet')) {
    fallbackIndex++;
    const name = attr(tag, 'name') ?? `Planilha${fallbackIndex}`;
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id');
    const target = (rid && relTarget.get(rid)) || `worksheets/sheet${fallbackIndex}.xml`;
    const xml = read(`xl/${target}`);
    if (xml === null) continue;
    sheets.push({ name, rows: parseSheet(xml, shared, isDateStyle, maxRows, maxCols) });
  }

  if (sheets.length === 0) throw new XlsxError('Nenhuma aba legível encontrada no arquivo.');
  return sheets;
}

function parseSheet(
  xml: string,
  shared: string[],
  isDateStyle: boolean[],
  maxRows: number,
  maxCols: number,
): CellValue[][] {
  const rows: CellValue[][] = [];
  const reRow = new RegExp(`<${NS}row(?:\\s([^>]*))?>([\\s\\S]*?)</${NS}row>|<${NS}row\\s([^>]*)/>`, 'g');
  let rm: RegExpExecArray | null;
  let implicitRow = 0;

  while ((rm = reRow.exec(xml)) !== null) {
    const rowAttrs = rm[1] ?? rm[3] ?? '';
    const body = rm[2] ?? '';
    const rIdx = rowAttrs ? Number(attr(`<row ${rowAttrs}>`, 'r')) - 1 : NaN;
    const rowIndex = Number.isFinite(rIdx) && rIdx >= 0 ? rIdx : implicitRow;
    implicitRow = rowIndex + 1;
    if (rowIndex >= maxRows) break;

    const cells: CellValue[] = [];
    const reCell = new RegExp(`<${NS}c(?:\\s([^>]*))?>([\\s\\S]*?)</${NS}c>|<${NS}c\\s([^>]*)/>`, 'g');
    let cm: RegExpExecArray | null;
    let implicitCol = 0;

    while ((cm = reCell.exec(body)) !== null) {
      const cellAttrs = cm[1] ?? cm[3] ?? '';
      const inner = cm[2] ?? '';
      const tag = `<c ${cellAttrs}>`;
      const ref = attr(tag, 'r');
      const ci = ref ? colIndex(ref) : implicitCol;
      implicitCol = ci + 1;
      if (ci < 0 || ci >= maxCols) continue;

      const t = attr(tag, 't');
      const sRaw = attr(tag, 's');
      const styleIdx = sRaw === null ? -1 : Number(sRaw);

      let value: CellValue = null;
      if (t === 'inlineStr') {
        value = textOfT(inner);
      } else if (t === 's') {
        const vm = pairRe('v').exec(inner);
        const idx = vm ? Number(decodeXml(vm[1]!)) : NaN;
        value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
      } else if (t === 'str') {
        const vm = pairRe('v').exec(inner);
        value = vm ? decodeXml(vm[1]!) : '';
      } else if (t === 'e') {
        value = null; // célula em erro (#N/D, #VALOR!) vira vazio
      } else {
        const vm = pairRe('v').exec(inner);
        if (vm) {
          const raw = decodeXml(vm[1]!);
          if (t === 'b') {
            value = raw === '1';
          } else {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              value = styleIdx >= 0 && isDateStyle[styleIdx] ? serialToDate(n) : n;
            } else {
              value = raw === '' ? null : raw;
            }
          }
        }
      }

      // Preenche buracos deixados por células ausentes no XML.
      while (cells.length < ci) cells.push(null);
      cells[ci] = value;
    }

    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }

  return rows;
}

/**
 * Converte uma matriz em registros usando a linha `headerRow` como cabeçalho.
 * Colunas sem título são descartadas; títulos repetidos recebem sufixo.
 */
export function toRecords(
  rows: CellValue[][],
  headerRow: number,
): Array<Record<string, CellValue>> {
  const header = rows[headerRow] ?? [];
  const names: Array<string | null> = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < header.length; i++) {
    const raw = header[i];
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : raw == null ? '' : String(raw).trim();
    if (!name) { names.push(null); continue; }
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    names.push(n === 0 ? name : `${name}__${n + 1}`);
  }

  const out: Array<Record<string, CellValue>> = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((c) => c === null || c === undefined || c === '')) continue;
    const rec: Record<string, CellValue> = {};
    for (let c = 0; c < names.length; c++) {
      const key = names[c];
      if (key) rec[key] = row[c] ?? null;
    }
    out.push(rec);
  }
  return out;
}
