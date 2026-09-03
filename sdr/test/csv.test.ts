import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapearLinhasCsv } from '../src/lib/csv.ts';

describe('parseCsv', () => {
  test('separa por vírgula quando o arquivo usa vírgula', () => {
    const linhas = parseCsv('nome,telefone\nFulano,5511999999999\n');
    assert.deepEqual(linhas, [['nome', 'telefone'], ['Fulano', '5511999999999']]);
  });

  test('detecta e separa por ponto-e-vírgula (Excel BR)', () => {
    const linhas = parseCsv('nome;telefone;contexto\nCiclana;5511988887777;Quer 200 pessoas, salão fechado\n');
    assert.deepEqual(linhas, [
      ['nome', 'telefone', 'contexto'],
      ['Ciclana', '5511988887777', 'Quer 200 pessoas, salão fechado'],
    ]);
  });

  test('respeita campo entre aspas com o delimitador dentro', () => {
    const linhas = parseCsv('nome,contexto\nFulano,"Festa grande, com banda e open bar"\n');
    assert.deepEqual(linhas, [['nome', 'contexto'], ['Fulano', 'Festa grande, com banda e open bar']]);
  });

  test('aspas duplicadas dentro de campo entre aspas viram uma aspa literal', () => {
    const linhas = parseCsv('nome\n"Ela disse ""oi"" pra mim"\n');
    assert.deepEqual(linhas, [['nome'], ['Ela disse "oi" pra mim']]);
  });

  test('ignora linhas totalmente em branco', () => {
    const linhas = parseCsv('nome,telefone\nFulano,5511999999999\n\n\nCiclano,5511988887777\n');
    assert.equal(linhas.length, 3);
  });

  test('funciona com CRLF (arquivo exportado do Windows)', () => {
    const linhas = parseCsv('nome,telefone\r\nFulano,5511999999999\r\n');
    assert.deepEqual(linhas, [['nome', 'telefone'], ['Fulano', '5511999999999']]);
  });
});

describe('mapearLinhasCsv', () => {
  test('reconhece colunas em ordem diferente e com nomes alternativos', () => {
    const linhas = parseCsv('telefone;nome;obs\n5511999999999;Fulano;interessado em casamento\n');
    const r = mapearLinhasCsv(linhas);
    assert.deepEqual(r.colunasReconhecidas.sort(), ['contexto', 'nome', 'telefone']);
    assert.equal(r.linhas.length, 1);
    assert.deepEqual(r.linhas[0]?.dados, {
      nome: 'Fulano', telefone: '5511999999999', email: null, origem: null,
      contexto: 'interessado em casamento',
    });
  });

  test('linha sem nome ou sem telefone vira erro com o motivo, sem travar as outras', () => {
    const linhas = parseCsv('nome,telefone\nFulano,5511999999999\n,5511988887777\nCiclano,\n');
    const r = mapearLinhasCsv(linhas);
    assert.equal(r.linhas.length, 3);
    assert.equal(r.linhas[0]?.motivo, null);
    assert.equal(r.linhas[1]?.motivo, 'sem nome');
    assert.equal(r.linhas[2]?.motivo, 'sem telefone');
  });

  test('pula linha totalmente vazia sem gerar erro', () => {
    const linhas = [['nome', 'telefone'], ['', ''], ['Fulano', '5511999999999']];
    const r = mapearLinhasCsv(linhas);
    assert.equal(r.linhas.length, 1);
  });

  test('csv vazio devolve listas vazias sem lançar', () => {
    const r = mapearLinhasCsv([]);
    assert.deepEqual(r, { colunasReconhecidas: [], linhas: [] });
  });

  test('sem coluna de nome/telefone reconhecível: nenhuma coluna aparece em colunasReconhecidas', () => {
    const linhas = parseCsv('coluna_a,coluna_b\nx,y\n');
    const r = mapearLinhasCsv(linhas);
    assert.deepEqual(r.colunasReconhecidas, []);
  });

  test('número da linha reportado bate com a posição no arquivo original (cabeçalho = linha 1)', () => {
    const linhas = parseCsv('nome,telefone\nFulano,5511999999999\n,5511988887777\n');
    const r = mapearLinhasCsv(linhas);
    assert.equal(r.linhas[1]?.numero, 3);
  });
});
