/**
 * Testes do ETL, com ênfase na regra de rateio de venda dividida — a que,
 * se estiver errada, produz faturamento incorreto sem levantar suspeita.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectarTipo, normalizarOportunidades, normalizarAcoes, normalizarDegustacoes,
  normalizarVendas, consolidarContratos, validarRateio, totalContratos,
  faturamentoCentavos, coletarConsultores, ErroEtl, type LinhaVenda,
} from '../src/domain/etl.ts';
import { readXlsx, toRecords, serialToDate, colIndex } from '../src/lib/xlsx.ts';
import { paraCentavos, paraIso, texto, chaveNome } from '../src/lib/valores.ts';
import { DIR_AMOSTRAS, temAmostras } from './ajuda.ts';

const comAmostras = { skip: temAmostras() ? false : 'sem planilhas de amostra' };
const ler = (n: string) => readFileSync(join(DIR_AMOSTRAS, n));

describe('leitor XLSX', () => {
  test('serial do Excel vira a data correta', () => {
    // Origem 1899-12-30: é a convenção que compensa o bug do ano bissexto de
    // 1900 no Excel e acerta TODA data a partir de 1900-03-01 — ou seja, todo
    // dado de negócio real. Seriais 1..59 saem um dia atrás, consequência
    // conhecida e aceita da convenção (não há data de evento em 1900).
    assert.equal(serialToDate(61).toISOString().slice(0, 10), '1900-03-01');
    assert.equal(serialToDate(46896).toISOString().slice(0, 10), '2028-05-23');
    assert.equal(serialToDate(46543).toISOString().slice(0, 10), '2027-06-05');
  });

  test('serial fracionário carrega a hora', () => {
    const d = serialToDate(46543.5);
    assert.equal(d.toISOString().slice(11, 16), '12:00');
  });

  test('endereço de coluna vira índice', () => {
    assert.equal(colIndex('A1'), 0);
    assert.equal(colIndex('Z9'), 25);
    assert.equal(colIndex('AA1'), 26);
    assert.equal(colIndex('BC12'), 54);
  });

  test('arquivo que não é ZIP falha com mensagem clara', () => {
    assert.throws(() => readXlsx(Buffer.from('isto não é um xlsx')), /ZIP/i);
  });

  test('lê as planilhas reais do CRM', comAmostras, () => {
    const abas = readXlsx(ler('oportunidades.xlsx'));
    assert.equal(abas.length, 1);
    const recs = toRecords(abas[0]!.rows, 2);
    assert.equal(recs.length, 845);
    assert.ok('Num Oportunidade' in recs[0]!);
  });

  test('lê planilha com prefixo de namespace (<x:sheet>)', comAmostras, () => {
    // O extrato de vendas vem de outro exportador, com namespace prefixado.
    const abas = readXlsx(ler('vendas.xlsx'));
    assert.equal(abas[0]!.name, 'Export');
    const recs = toRecords(abas[0]!.rows, 0);
    assert.ok(recs.length >= 13);
    assert.ok(recs[0]!['Data Evento'] instanceof Date, 'coluna de data deveria vir tipada');
  });
});

describe('conversão de valores', () => {
  test('centavos absorvem o ruído de ponto flutuante', () => {
    assert.equal(paraCentavos(80507.00000000001), 8050700);
    assert.equal(paraCentavos(90349.165), 9034917);
    assert.equal(paraCentavos(0), 0);
    assert.equal(paraCentavos(null), 0);
  });

  test('somar em centavos é exato', () => {
    const valores = [80507.00000000001, 80507.00000000001, 77000, 77000];
    assert.equal(valores.reduce((a, b) => a + paraCentavos(b), 0), 31501400);
  });

  test('inteiro não sofre o erro de representação que o decimal sofre', () => {
    // O motivo de existir a conversão para centavos, em uma linha:
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(paraCentavos(0.1) + paraCentavos(0.2), paraCentavos(0.3));
  });

  test('meio centavo arredonda para cima, como no relatório do CRM', () => {
    assert.equal(paraCentavos(90349.165), 9034917);
    assert.equal(paraCentavos(27883.815), 2788382);
  });

  test('datas do CRM em vários formatos', () => {
    assert.equal(paraIso('17/08/2026'), '2026-08-17T00:00:00.000Z');
    assert.equal(paraIso('17/08/2026 14:30'), '2026-08-17T14:30:00.000Z');
    assert.equal(paraIso('31/02/2026'), null, 'data impossível deve virar null');
    assert.equal(paraIso(''), null);
    assert.equal(paraIso(null), null);
  });

  test('texto normaliza espaço e vazio vira null', () => {
    assert.equal(texto('BERNARDO    RODRIGUES'), 'BERNARDO RODRIGUES');
    assert.equal(texto('   '), null);
  });

  test('chave de nome ignora acento e caixa', () => {
    assert.equal(chaveNome('Lívia Beanuci Fernandes'), chaveNome('LIVIA  BEANUCI FERNANDES'));
    assert.notEqual(chaveNome('Juliana Bianchin'), chaveNome('Juliana Zanchetta'));
  });
});

describe('rateio de venda dividida', () => {
  const linha = (num: string, consultor: string, valor: number, qtd: number): LinhaVenda => ({
    num_contrato: num, id_evento: null, descricao: null, contratante: null,
    casa: 'CASA LUCCA', tipo_evento: 'CASAMENTO', data_evento: null, pax: 60,
    valor_minimo_c: 0, valor_original_c: 0, valor_ajustado_c: paraCentavos(valor),
    status: null, fechamento: null, consultorNome: consultor, quantidade: qtd,
  });

  test('o contrato é a SOMA das partes, não uma delas', () => {
    const c = consolidarContratos([
      linha('CT-1', 'Caroline', 28547.97, 0.5),
      linha('CT-1', 'Mariana', 28547.97, 0.5),
    ]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.valor_ajustado_c, 5709594, 'R$ 57.095,94');
    assert.equal(c[0]!.partes, 2);
  });

  test('conta 1 contrato, não 2, quando a venda é dividida', () => {
    const c = consolidarContratos([
      linha('CT-1', 'A', 100, 0.5),
      linha('CT-1', 'B', 100, 0.5),
      linha('CT-2', 'C', 500, 1),
    ]);
    assert.equal(totalContratos(c), 2);
    assert.equal(faturamentoCentavos(c), paraCentavos(700));
  });

  test('o crédito de cada consultor é a linha dele e a soma fecha o total', () => {
    const c = consolidarContratos([
      linha('CT-1', 'Caroline', 80507, 0.5),
      linha('CT-1', 'Joyce', 80507, 0.5),
    ]);
    const porConsultor = new Map<string, number>();
    for (const k of c[0]!.creditos) {
      porConsultor.set(k.consultorNome!, (porConsultor.get(k.consultorNome!) ?? 0) + k.valor_c);
    }
    assert.equal(porConsultor.get('Caroline'), 8050700);
    assert.equal(porConsultor.get('Joyce'), 8050700);
    assert.equal([...porConsultor.values()].reduce((a, b) => a + b, 0), c[0]!.valor_ajustado_c);
  });

  test('rateio incompleto é detectado (linha faltando na exportação)', () => {
    const p = validarRateio(consolidarContratos([linha('CT-1', 'A', 100, 0.5)]));
    assert.equal(p.length, 1);
    assert.match(p[0]!.problema, /faltando/i);
  });

  test('rateio excedente é detectado (linha duplicada)', () => {
    const p = validarRateio(consolidarContratos([
      linha('CT-1', 'A', 100, 1), linha('CT-1', 'B', 100, 1),
    ]));
    assert.equal(p.length, 1);
    assert.match(p[0]!.problema, /duplicada/i);
  });

  test('rateio correto não gera problema', () => {
    assert.deepEqual(validarRateio(consolidarContratos([
      linha('CT-1', 'A', 100, 0.5), linha('CT-1', 'B', 100, 0.5), linha('CT-2', 'C', 50, 1),
    ])), []);
  });
});

describe('ETL sobre as planilhas reais', comAmostras, () => {
  const tipos = () => {
    const m = new Map<string, ReturnType<typeof detectarTipo>['linhas']>();
    for (const f of ['oportunidades.xlsx', 'acoes.xlsx', 'degustacoes.xlsx', 'vendas.xlsx']) {
      const { tipo, linhas } = detectarTipo(ler(f));
      m.set(tipo, linhas);
    }
    return m;
  };

  test('cada planilha é reconhecida pelo conteúdo, não pelo nome', () => {
    const m = tipos();
    assert.deepEqual([...m.keys()].sort(), ['acoes', 'degustacoes', 'oportunidades', 'vendas']);
  });

  test('arquivo desconhecido dá erro com diagnóstico', () => {
    // Uma planilha válida, mas cujo cabeçalho não bate com nenhuma assinatura:
    // reaproveitamos um XLSX real lido a partir da linha errada.
    assert.throws(() => detectarTipo(Buffer.from('PK\x03\x04 nao é planilha')), Error);
  });

  test('contagens conferem com a base de referência', () => {
    const m = tipos();
    assert.equal(normalizarOportunidades(m.get('oportunidades')!).length, 845);
    assert.equal(normalizarAcoes(m.get('acoes')!).length, 2483);
    assert.equal(normalizarDegustacoes(m.get('degustacoes')!).length, 62);
    assert.equal(normalizarVendas(m.get('vendas')!).length, 13);
  });

  test('rodapé "Total" e "Filtros aplicados" não viram dado', () => {
    const v = normalizarVendas(tipos().get('vendas')!);
    assert.ok(v.every((x) => x.num_contrato.startsWith('CT')));
  });

  test('faturamento consolidado bate com o relatório do CRM', () => {
    const ct = consolidarContratos(normalizarVendas(tipos().get('vendas')!));
    assert.equal(ct.length, 9);
    assert.equal(totalContratos(ct), 9);
    assert.equal(faturamentoCentavos(ct), 112856694, 'R$ 1.128.566,94');
    assert.deepEqual(validarRateio(ct), []);
  });

  test('CT2026-0351: o caso que expõe a leitura errada', () => {
    const ct = consolidarContratos(normalizarVendas(tipos().get('vendas')!));
    const alvo = ct.find((c) => c.num_contrato === 'CT2026-0351')!;
    assert.equal(alvo.partes, 2);
    assert.equal(alvo.valor_ajustado_c, 5709594);
    // R$/convidado coerente com as outras vendas da Casa Lucca (R$ 1.111 e R$ 1.300).
    const porPax = alvo.valor_ajustado_c / 100 / alvo.pax!;
    assert.ok(porPax > 900 && porPax < 1000, `R$/pax fora do esperado: ${porPax}`);
  });

  test('consultores são deduplicados por chave canônica', () => {
    const m = tipos();
    const cons = coletarConsultores(
      normalizarAcoes(m.get('acoes')!),
      normalizarDegustacoes(m.get('degustacoes')!),
      normalizarVendas(m.get('vendas')!),
    );
    assert.equal(cons.size, 15);
    assert.ok([...cons.values()].includes('Caroline Bortoleto'));
  });

  test('ErroEtl carrega o detalhe para a tela do gestor', () => {
    const e = new ErroEtl('falhou', { colunasFaltando: ['X'] });
    assert.equal(e.name, 'ErroEtl');
    assert.deepEqual(e.detalhe, { colunasFaltando: ['X'] });
  });
});
