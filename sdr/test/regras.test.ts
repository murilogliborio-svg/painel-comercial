import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  regrasPadrao, dentroDaJanelaComercial, contemOptOut, leadElegivel,
  calcularProximaMensagemEm, objetivoDoPasso, nomeTemplateDoPasso, janelaDeServicoAtiva, type Lead,
} from '../src/domain/regras.ts';

function leadBase(overrides: Partial<Lead> = {}): Lead {
  return {
    estagio: 'novo', opt_out: 0, automacao_ativa: 1, sequencia_passo: 0,
    proxima_mensagem_em: null, mensagens_sem_resposta: 0, ...overrides,
  };
}

describe('janela comercial', () => {
  test('aceita horário e dia dentro da janela padrão', () => {
    const regras = regrasPadrao();
    // Quarta-feira (dia 3), 14h.
    const quarta14h = new Date('2026-09-02T14:00:00');
    assert.ok(dentroDaJanelaComercial(regras, quarta14h));
  });

  test('recusa fora do horário', () => {
    const regras = regrasPadrao();
    const noite = new Date('2026-09-02T22:00:00');
    assert.ok(!dentroDaJanelaComercial(regras, noite));
  });

  test('recusa fim de semana', () => {
    const regras = regrasPadrao();
    const domingo = new Date('2026-09-06T14:00:00'); // domingo
    assert.ok(!dentroDaJanelaComercial(regras, domingo));
  });
});

describe('detecção de opt-out', () => {
  const palavras = regrasPadrao().palavrasOptOut;

  test('reconhece pedidos comuns de parar', () => {
    for (const texto of ['Pode parar de mandar mensagem', 'PARE DE ME CHAMAR', 'quero sair da lista, obrigada']) {
      assert.ok(contemOptOut(texto, palavras), `deveria detectar opt-out em "${texto}"`);
    }
  });

  test('ignora acentuação e caixa', () => {
    assert.ok(contemOptOut('não quero mais receber isso', palavras));
  });

  test('não marca conversa normal como opt-out', () => {
    for (const texto of ['Oi, tudo bem?', 'Quero saber mais sobre o evento', 'Pode ser sexta às 15h']) {
      assert.ok(!contemOptOut(texto, palavras), `não deveria detectar opt-out em "${texto}"`);
    }
  });
});

describe('elegibilidade de envio — a barreira central da automação autônoma', () => {
  const regras = regrasPadrao();
  const quarta14h = new Date('2026-09-02T14:00:00');

  test('lead novo, dentro da janela, sem histórico: elegível', () => {
    const r = leadElegivel(leadBase(), regras, quarta14h);
    assert.equal(r.elegivel, true);
  });

  test('opt-out sempre bloqueia, mesmo com automação ligada', () => {
    const r = leadElegivel(leadBase({ opt_out: 1 }), regras, quarta14h);
    assert.equal(r.elegivel, false);
    assert.equal(r.motivo, 'opt_out');
  });

  test('automação pausada manualmente bloqueia', () => {
    const r = leadElegivel(leadBase({ automacao_ativa: 0 }), regras, quarta14h);
    assert.equal(r.motivo, 'automacao_pausada_manualmente');
  });

  for (const estagio of ['respondeu', 'quente', 'convertido', 'perdido', 'pausado']) {
    test(`estágio "${estagio}" tira o lead da automação`, () => {
      const r = leadElegivel(leadBase({ estagio }), regras, quarta14h);
      assert.equal(r.elegivel, false);
      assert.equal(r.motivo, `estagio_${estagio}`);
    });
  }

  test('sequência já concluída não gera mais mensagem', () => {
    const r = leadElegivel(leadBase({ sequencia_passo: regras.passos.length }), regras, quarta14h);
    assert.equal(r.motivo, 'sequencia_concluida');
  });

  test('excesso de mensagens sem resposta pausa e pede humano', () => {
    const r = leadElegivel(
      leadBase({ mensagens_sem_resposta: regras.maxSequenciaSemResposta }), regras, quarta14h,
    );
    assert.equal(r.motivo, 'sem_resposta_excedeu_limite');
  });

  test('fora do horário comercial bloqueia mesmo com tudo mais ok', () => {
    const noite = new Date('2026-09-02T22:00:00');
    const r = leadElegivel(leadBase(), regras, noite);
    assert.equal(r.motivo, 'fora_horario_comercial');
  });

  test('intervalo mínimo ainda não vencido bloqueia', () => {
    const futuro = new Date(quarta14h.getTime() + 3600_000).toISOString();
    const r = leadElegivel(leadBase({ proxima_mensagem_em: futuro }), regras, quarta14h);
    assert.equal(r.motivo, 'ainda_nao_venceu_intervalo');
  });

  test('intervalo já vencido libera', () => {
    const passado = new Date(quarta14h.getTime() - 3600_000).toISOString();
    const r = leadElegivel(leadBase({ proxima_mensagem_em: passado }), regras, quarta14h);
    assert.equal(r.elegivel, true);
  });
});

describe('sequência de aquecimento', () => {
  test('calcula a data do próximo passo somando os dias configurados', () => {
    const regras = regrasPadrao();
    const agora = new Date('2026-09-02T14:00:00Z');
    const proxima = calcularProximaMensagemEm(regras, 1, agora);
    const esperado = new Date(agora.getTime() + regras.passos[1]!.diasDeEspera * 86_400_000);
    assert.equal(proxima, esperado.toISOString());
  });

  test('sem mais passos, devolve null', () => {
    const regras = regrasPadrao();
    const r = calcularProximaMensagemEm(regras, regras.passos.length, new Date());
    assert.equal(r, null);
  });

  test('objetivoDoPasso cai num texto genérico fora do intervalo configurado', () => {
    const regras = regrasPadrao();
    assert.match(objetivoDoPasso(regras, 999), /./);
  });

  test('nomeTemplateDoPasso devolve string vazia fora do intervalo configurado', () => {
    const regras = regrasPadrao();
    assert.equal(nomeTemplateDoPasso(regras, 999), '');
  });
});

describe('janela de serviço de 24h (texto livre x modelo aprovado)', () => {
  const agora = new Date('2026-09-02T14:00:00Z');

  test('sem resposta alguma do lead: janela fechada', () => {
    assert.equal(janelaDeServicoAtiva(null, agora), false);
  });

  test('lead respondeu há 1h: janela aberta', () => {
    const umaHoraAtras = new Date(agora.getTime() - 3_600_000).toISOString();
    assert.equal(janelaDeServicoAtiva(umaHoraAtras, agora), true);
  });

  test('lead respondeu há 23h59: ainda dentro da janela', () => {
    const quaseNoLimite = new Date(agora.getTime() - (24 * 3_600_000 - 60_000)).toISOString();
    assert.equal(janelaDeServicoAtiva(quaseNoLimite, agora), true);
  });

  test('lead respondeu há 25h: janela fechada, precisa de modelo', () => {
    const vinteECincoHorasAtras = new Date(agora.getTime() - 25 * 3_600_000).toISOString();
    assert.equal(janelaDeServicoAtiva(vinteECincoHorasAtras, agora), false);
  });

  test('data de resposta no futuro (relógio bagunçado) não quebra: trata como fechada', () => {
    const futuro = new Date(agora.getTime() + 3_600_000).toISOString();
    assert.equal(janelaDeServicoAtiva(futuro, agora), false);
  });
});
