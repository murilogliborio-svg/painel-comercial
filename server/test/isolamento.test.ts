/**
 * TESTE DE SEGURANÇA MAIS IMPORTANTE DO SISTEMA.
 *
 * Prova que um consultor autenticado não alcança dado de outro consultor —
 * nem pelo caminho normal, nem forçando parâmetros, nem escrevendo em
 * oportunidade alheia. Se qualquer asserção aqui falhar, o sistema não deve
 * ir para produção: significa que dado pessoal de cliente está atravessando
 * a fronteira entre carteiras.
 *
 * Ao acrescentar uma rota que devolve dado de cliente, acrescente o caso
 * correspondente neste arquivo.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  subirAmbiente, importarAmostras, idConsultor, temAmostras,
  type Ambiente, type Cliente,
} from './ajuda.ts';

describe('isolamento entre consultores', { skip: temAmostras() ? false : 'sem planilhas de amostra' }, () => {
  let amb: Ambiente;
  let gestor: Cliente;
  let caroline: Cliente;
  let joyce: Cliente;
  let idCaroline: string;
  let idJoyce: string;

  before(async () => {
    amb = await subirAmbiente();
    await amb.criarUsuario({ email: 'gestor@terra.com', papel: 'admin', nome: 'Gestor' });
    gestor = amb.cliente();
    await gestor.login('gestor@terra.com');
    await importarAmostras(amb, gestor);

    idCaroline = await idConsultor(amb, 'Caroline Bortoleto');
    idJoyce = await idConsultor(amb, 'Joyce Morais');

    await amb.criarUsuario({ email: 'caroline@terra.com', papel: 'consultor', consultorId: idCaroline });
    await amb.criarUsuario({ email: 'joyce@terra.com', papel: 'consultor', consultorId: idJoyce });

    caroline = amb.cliente();
    await caroline.login('caroline@terra.com');
    joyce = amb.cliente();
    await joyce.login('joyce@terra.com');
  });

  after(async () => { await amb?.fechar(); });

  test('o resumo do consultor traz apenas os números dele', async () => {
    const r = await caroline.req('GET', '/api/painel/resumo');
    assert.equal(r.status, 200);
    assert.equal(r.corpo.escopo, idCaroline);
    // Crédito da Caroline nos dados reais, não o faturamento do time.
    assert.equal(r.corpo.totais.faturamento, 327511.97);
    assert.notEqual(r.corpo.totais.faturamento, 1128566.94);
  });

  test('forçar ?consultor= de outro é 403, não lista vazia', async () => {
    const r = await caroline.req('GET', `/api/painel/resumo?consultor=${idJoyce}`);
    assert.equal(r.status, 403);
    assert.match(String(r.corpo.mensagem), /seus próprios dados/i);
  });

  test('o ranking do consultor tem só a linha dele', async () => {
    const r = await caroline.req('GET', '/api/painel/consultores');
    assert.equal(r.status, 200);
    assert.equal(r.corpo.consultores.length, 1);
    assert.equal(r.corpo.consultores[0].consultor_id, idCaroline);
  });

  test('o consultor recebe média e melhor do time, sem nomes de terceiros nas listas', async () => {
    const r = await caroline.req('GET', '/api/painel/consultores');
    const ref = r.corpo.referencia;
    assert.ok(ref, 'referência do time deveria existir');
    assert.equal(ref.tamanhoTime, 15);
    const fat = ref.metricas.find((m: { campo: string }) => m.campo === 'faturamento');
    assert.ok(fat.media > 0 && fat.melhor >= fat.meu);
    assert.equal(typeof fat.posicao, 'number');
  });

  test('listas nominais são restritas à carteira do consultor', async () => {
    const doTime = await gestor.req('GET', '/api/listas/vencidas?limite=500');
    const daCaroline = await caroline.req('GET', '/api/listas/vencidas?limite=500');
    const daJoyce = await joyce.req('GET', '/api/listas/vencidas?limite=500');

    assert.ok(daCaroline.corpo.itens.length < doTime.corpo.itens.length);
    assert.ok(daJoyce.corpo.itens.length < doTime.corpo.itens.length);

    // Nenhum cliente aparece nas duas carteiras ao mesmo tempo.
    const nomesC = new Set(daCaroline.corpo.itens.map((i: { cliente: string }) => i.cliente));
    const nomesJ = daJoyce.corpo.itens.map((i: { cliente: string }) => i.cliente);
    const vazamento = nomesJ.filter((n: string) => nomesC.has(n));
    assert.deepEqual(vazamento, [], 'cliente de uma carteira apareceu na outra');
  });

  test('todos os tipos de lista respeitam o escopo', async () => {
    for (const tipo of ['vencidas', 'aguardando', 'sem_sucesso', 'perdidos', 'degustacoes', 'contratos']) {
      const time = await gestor.req('GET', `/api/listas/${tipo}?limite=500`);
      const meu = await caroline.req('GET', `/api/listas/${tipo}?limite=500`);
      assert.equal(meu.status, 200, `lista ${tipo} deveria responder 200`);
      assert.ok(
        meu.corpo.itens.length <= time.corpo.itens.length,
        `lista ${tipo}: consultor viu mais itens que o gestor`,
      );
      const forcado = await caroline.req('GET', `/api/listas/${tipo}?consultor=${idJoyce}`);
      assert.equal(forcado.status, 403, `lista ${tipo} aceitou consultor forçado`);
    }
  });

  test('contratos do consultor mostram a parte dele, não o contrato inteiro', async () => {
    const r = await caroline.req('GET', '/api/listas/contratos');
    // CT2026-0351 vale R$ 57.095,94; a metade da Caroline é R$ 28.547,97.
    const item = r.corpo.itens.find((i: { referencia: string }) => i.referencia === '28547.97');
    assert.ok(item, 'a parte rateada da Caroline deveria aparecer');
  });

  test('consultor não escreve tratativa em oportunidade de outro', async () => {
    const daJoyce = await joyce.req('GET', '/api/listas/vencidas');
    const alvo = daJoyce.corpo.itens[0];
    assert.ok(alvo?.num_oportunidade, 'a Joyce precisa ter ao menos uma pendência');

    const r = await caroline.req('POST', '/api/trabalho/tratativa', {
      num_oportunidade: alvo.num_oportunidade,
      chave_acao: alvo.chave,
      resultado: 'contato_feito',
    });
    assert.equal(r.status, 403);
    assert.match(String(r.corpo.mensagem), /não está na sua carteira/i);
  });

  test('consultor não lê notas de oportunidade de outro', async () => {
    const daJoyce = await joyce.req('GET', '/api/listas/vencidas');
    const num = daJoyce.corpo.itens[0].num_oportunidade;
    await joyce.req('POST', '/api/trabalho/notas', { num_oportunidade: num, texto: 'nota privada da Joyce' });

    const r = await caroline.req('GET', `/api/trabalho/notas/${num}`);
    assert.equal(r.status, 403);

    const minhas = await joyce.req('GET', `/api/trabalho/notas/${num}`);
    assert.equal(minhas.status, 200);
    assert.equal(minhas.corpo.notas.length, 1);
  });

  test('consultor não acessa rotas de gestão', async () => {
    const proibidas: Array<[string, string, unknown]> = [
      ['GET', '/api/importacao', undefined],
      ['GET', '/api/admin/usuarios', undefined],
      ['GET', '/api/admin/auditoria', undefined],
      ['POST', '/api/metas', { consultor_id: 'x', metrica: 'contratos', alvo: 1, periodo_ini: '2026-08-01', periodo_fim: '2026-08-31' }],
      ['POST', '/api/importacao/preparar', {}],
    ];
    for (const [metodo, caminho, corpo] of proibidas) {
      const r = await caroline.req(metodo, caminho, corpo);
      assert.equal(r.status, 403, `${metodo} ${caminho} deveria ser 403, veio ${r.status}`);
    }
  });

  test('usuário somente leitura não escreve', async () => {
    const id = await idConsultor(amb, 'Daniele Santos');
    await amb.criarUsuario({
      email: 'leitor@terra.com', papel: 'consultor', consultorId: id, podeEscrever: false,
    });
    const leitor = amb.cliente();
    await leitor.login('leitor@terra.com');

    const lista = await leitor.req('GET', '/api/listas/vencidas');
    assert.equal(lista.status, 200, 'leitura deve continuar funcionando');

    const escrita = await leitor.req('POST', '/api/trabalho/tratativa', {
      num_oportunidade: lista.corpo.itens[0].num_oportunidade,
      chave_acao: lista.corpo.itens[0].chave,
      resultado: 'contato_feito',
    });
    assert.equal(escrita.status, 403);
    assert.match(String(escrita.corpo.mensagem), /somente leitura/i);
  });

  test('consultor sem vínculo recebe erro explicativo, não dados', async () => {
    await amb.criarUsuario({ email: 'orfao@terra.com', papel: 'consultor', consultorId: null });
    const orfao = amb.cliente();
    await orfao.login('orfao@terra.com');
    const r = await orfao.req('GET', '/api/painel/resumo');
    assert.equal(r.status, 403);
    assert.match(String(r.corpo.mensagem), /não está vinculada/i);
  });

  test('o gestor enxerga o time inteiro', async () => {
    const r = await gestor.req('GET', '/api/painel/resumo');
    assert.equal(r.corpo.totais.faturamento, 1128566.94);
    const rank = await gestor.req('GET', '/api/painel/consultores');
    assert.equal(rank.corpo.consultores.length, 15);
  });

  test('acesso a lista nominal fica registrado na auditoria', async () => {
    await caroline.req('GET', '/api/listas/aguardando');
    const r = await gestor.req('GET', '/api/admin/auditoria?acao=lista.consultada');
    const daCaroline = r.corpo.registros.filter(
      (x: { email: string }) => x.email === 'caroline@terra.com',
    );
    assert.ok(daCaroline.length > 0, 'consulta a lista nominal deveria estar auditada');
  });
});
