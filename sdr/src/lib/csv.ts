/**
 * Parser de CSV mínimo, sem dependência — suporta campos entre aspas (com
 * vírgula/ponto-e-vírgula/quebra de linha dentro), aspas escapadas (""), e
 * detecta sozinho se o arquivo usa vírgula ou ponto-e-vírgula como
 * separador (Excel em português costuma exportar com ponto-e-vírgula).
 */
export function parseCsv(texto: string): string[][] {
  const normalizado = texto.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
  const primeiraLinha = normalizado.slice(0, normalizado.indexOf('\n') === -1 ? undefined : normalizado.indexOf('\n'));
  const delimitador = detectarDelimitador(primeiraLinha);

  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let dentroAspas = false;

  for (let i = 0; i < normalizado.length; i++) {
    const c = normalizado[i];
    if (dentroAspas) {
      if (c === '"') {
        if (normalizado[i + 1] === '"') { campo += '"'; i++; } else { dentroAspas = false; }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') { dentroAspas = true; continue; }
    if (c === delimitador) { linha.push(campo); campo = ''; continue; }
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += c;
  }
  if (campo.length > 0 || linha.length > 0) { linha.push(campo); linhas.push(linha); }

  return linhas
    .map((l) => l.map((c) => c.trim()))
    .filter((l) => l.some((c) => c !== ''));
}

function detectarDelimitador(primeiraLinha: string): ',' | ';' {
  const ponto = (primeiraLinha.match(/;/g) || []).length;
  const virgula = (primeiraLinha.match(/,/g) || []).length;
  return ponto > virgula ? ';' : ',';
}

export interface LinhaLeadImportado {
  nome: string;
  telefone: string;
  email: string | null;
  origem: string | null;
  contexto: string | null;
}

const ALIASES_COLUNA: Record<keyof LinhaLeadImportado, string[]> = {
  nome: ['nome', 'name', 'cliente', 'contato'],
  telefone: ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'número', 'fone'],
  email: ['email', 'e-mail'],
  origem: ['origem', 'source', 'fonte'],
  contexto: ['contexto', 'context', 'observacoes', 'observações', 'obs', 'notas', 'nota'],
};

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Lê a primeira linha como cabeçalho (por nome de coluna, em qualquer
 * ordem — ver ALIASES_COLUNA) e devolve as linhas já mapeadas para o
 * formato de lead. Linhas sem nome/telefone reconhecíveis não travam a
 * importação inteira: o motivo fica junto de cada linha para o chamador
 * decidir o que reportar.
 */
export function mapearLinhasCsv(linhas: string[][]): {
  colunasReconhecidas: (keyof LinhaLeadImportado)[];
  linhas: Array<{ numero: number; dados: LinhaLeadImportado | null; motivo: string | null }>;
} {
  if (linhas.length === 0) return { colunasReconhecidas: [], linhas: [] };

  const cabecalho = linhas[0]!.map((c) => semAcento(c.toLowerCase().trim()));
  const indices: Partial<Record<keyof LinhaLeadImportado, number>> = {};
  for (const [campo, aliases] of Object.entries(ALIASES_COLUNA) as Array<[keyof LinhaLeadImportado, string[]]>) {
    const idx = cabecalho.findIndex((h) => aliases.some((a) => semAcento(a) === h));
    if (idx !== -1) indices[campo] = idx;
  }

  const colunasReconhecidas = Object.keys(indices) as (keyof LinhaLeadImportado)[];
  const resultado: ReturnType<typeof mapearLinhasCsv>['linhas'] = [];

  for (let i = 1; i < linhas.length; i++) {
    const l = linhas[i]!;
    const num = i + 1; // número da linha no arquivo original (1 = cabeçalho)
    const pega = (campo: keyof LinhaLeadImportado): string =>
      indices[campo] !== undefined ? (l[indices[campo]!] ?? '').trim() : '';

    const nome = pega('nome');
    const telefone = pega('telefone');
    if (!nome && !telefone) continue; // linha em branco
    if (!nome) { resultado.push({ numero: num, dados: null, motivo: 'sem nome' }); continue; }
    if (!telefone) { resultado.push({ numero: num, dados: null, motivo: 'sem telefone' }); continue; }

    resultado.push({
      numero: num,
      dados: {
        nome, telefone,
        email: pega('email') || null,
        origem: pega('origem') || null,
        contexto: pega('contexto') || null,
      },
      motivo: null,
    });
  }

  return { colunasReconhecidas, linhas: resultado };
}
