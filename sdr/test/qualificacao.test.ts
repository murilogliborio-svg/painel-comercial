import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirAmbiente, type Ambiente } from './ajuda.ts';
import { ulid } from '../src/lib/ids.ts';

/**
 * Testes de integração da fase 2 (qualificação por I.A. depois que o lead
 * responde). O ambiente de teste nunca tem ANTHROPIC_API_KEY configurada —
 * então todo caminho aqui exercita o comportamento com a I.A. indisponível,
 * que é justamente a parte que precisa ser robusta: um lead nunca pode
 * ficar preso travando o mesmo erro pra sempre. O conteúdo da resposta da
 * I.A. em si (quando a chave existe) não é testável sem chamar a API de
 * verdade, então fica fora do escopo de teste automatizado, igual já
 * acontecia com gerarMensagem() antes desta mudança.
 */

// buscarLeadPorTelefone normaliza pra dígitos antes de comparar — um
// telefone de teste precisa já ser só dígitos, senão nunca bate e o
// webhook segue pelo caminho de "número desconhecido" em vez de achar o
// lead que o teste preparou.
let contadorFone = 0;
function numeroFone(): string {
  contadorFone += 1;
  return `5511${String(900000000 + contadorFone).padStart(9, '0')}`;
}

async function criarLeadDireto(
  amb: Ambiente,
  userId: string,
  telefone: string,
  overrides: Partial<{ estagio: string; automacao_ativa: number; qualificacao_ativa: number }> = {},
): Promise<string> {
  const id = ulid();
  const agora = new Date().toISOString();
  await amb.db.run(
    `INSERT INTO leads
       (id, nome, telefone, estagio, automacao_ativa, qualificacao_ativa, criado_por, criado_em, atualizado_em)
     VALUES (?, 'Cliente Teste', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, telefone, overrides.estagio ?? 'novo', overrides.automacao_ativa ?? 1,
      overrides.qualificacao_ativa ?? 0, userId, agora, agora,
    ],
  );
  return id;
}

async function leadAtual(amb: Ambiente, id: string) {
  return amb.db.get<{
    estagio: string; qualificacao_ativa: number; qualificacao_mensagens: number;
  }>('SELECT estagio, qualificacao_ativa, qualificacao_mensagens FROM leads WHERE id = ?', [id]);
}

async function mensagensDoLead(amb: Ambiente, id: string) {
  return amb.db.all<{ direcao: string; status: string }>(
    'SELECT direcao, status FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC', [id],
  );
}

function webhookMensagem(telefone: string, texto: string, idExterno: string) {
  return {
    entry: [{ changes: [{ value: { messages: [{ from: telefone, id: idExterno, type: 'text', text: { body: texto } }] } }] }],
  };
}

describe('qualificação por I.A. após a primeira resposta do lead', () => {
  let amb: Ambiente;
  let userId: string;
  before(async () => {
    amb = await subirAmbiente();
    userId = await amb.criarUsuario({ email: 'admin@teste.com', papel: 'admin' });
  });
  after(async () => { await amb.fechar(); });

  test('sem ANTHROPIC_API_KEY: encerra a qualificação de forma graciosa, sem travar o lead', async () => {
    const telefone = numeroFone();
    const id = await criarLeadDireto(amb, userId, telefone);

    const r = await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Oi, tenho interesse!', 'wamid.q1')),
    });
    assert.equal(r.status, 200);

    const lead = await leadAtual(amb, id);
    // registrarResposta sempre roda primeiro (isso não depende da I.A.);
    // a qualificação tenta, falha por falta de chave, e encerra sozinha —
    // não fica "qualificacao_ativa = 1" pra sempre travando o lead.
    assert.equal(lead?.estagio, 'respondeu');
    assert.equal(lead?.qualificacao_ativa, 0);

    const msgs = await mensagensDoLead(amb, id);
    assert.equal(msgs.length, 1); // só a mensagem de entrada — nenhuma tentativa de saída sem chave
    assert.equal(msgs[0]?.direcao, 'entrada');
  });

  test('qualificação desligada na configuração: primeira resposta não tenta I.A.', async () => {
    const admin = amb.cliente();
    await admin.login('admin@teste.com');
    const rDesliga = await admin.req('PUT', '/api/config/qualificacao', {
      ativa: false, maxMensagens: 6, objetivo: 'teste',
    });
    assert.equal(rDesliga.status, 200);

    const telefone = numeroFone();
    const id = await criarLeadDireto(amb, userId, telefone);

    await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Oi!', 'wamid.q2')),
    });

    const lead = await leadAtual(amb, id);
    assert.equal(lead?.estagio, 'respondeu');
    assert.equal(lead?.qualificacao_ativa, 0);
    const msgs = await mensagensDoLead(amb, id);
    assert.equal(msgs.length, 1); // nenhuma tentativa de resposta automática

    // Religa para não vazar estado entre os testes seguintes.
    const login2 = amb.cliente();
    await login2.login('admin@teste.com');
    await login2.req('PUT', '/api/config/qualificacao', { ativa: true, maxMensagens: 6, objetivo: 'teste' });
  });

  test('humano já assumiu (automacao_ativa=0): resposta do lead não reativa a I.A.', async () => {
    const telefone = numeroFone();
    const id = await criarLeadDireto(amb, userId, telefone, { automacao_ativa: 0 });

    await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Oi de novo!', 'wamid.q3')),
    });

    const lead = await leadAtual(amb, id);
    assert.equal(lead?.qualificacao_ativa, 0);
    const msgs = await mensagensDoLead(amb, id);
    assert.equal(msgs.length, 1);
  });

  test('qualificação já encerrada antes (estágio "quente"): nova resposta não reabre sozinha', async () => {
    const telefone = numeroFone();
    const id = await criarLeadDireto(amb, userId, telefone, { estagio: 'quente', qualificacao_ativa: 0 });

    await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Mais uma pergunta', 'wamid.q4')),
    });

    const lead = await leadAtual(amb, id);
    assert.equal(lead?.qualificacao_ativa, 0);
    const msgs = await mensagensDoLead(amb, id);
    assert.equal(msgs.length, 1); // registrou a mensagem, mas não tentou responder sozinha
  });

  test('opt-out continua tendo prioridade: nem registra resposta nem tenta qualificar', async () => {
    const telefone = numeroFone();
    const id = await criarLeadDireto(amb, userId, telefone);

    await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Pode parar de mandar mensagem', 'wamid.q5')),
    });

    const lead = await amb.db.get<{ opt_out: number; estagio: string }>(
      'SELECT opt_out, estagio FROM leads WHERE id = ?', [id],
    );
    assert.equal(lead?.opt_out, 1);
    assert.notEqual(lead?.estagio, 'quente');
  });

  test('número desconhecido (lead inexistente): é criado e pode qualificar, mas nunca entra na automação de aquecimento frio', async () => {
    const telefone = numeroFone();
    const r = await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookMensagem(telefone, 'Olá, gostaria de um orçamento', 'wamid.q6')),
    });
    assert.equal(r.status, 200);

    const lead = await amb.db.get<{ id: string; estagio: string; automacao_ativa: number; origem: string }>(
      'SELECT id, estagio, automacao_ativa, origem FROM leads WHERE telefone = ?', [telefone],
    );
    assert.ok(lead, 'lead deveria ter sido criado automaticamente');
    assert.equal(lead?.estagio, 'respondeu');
    assert.equal(lead?.origem, 'whatsapp_inbound');
    // automacao_ativa continua 1 (não foi desligado à força) — mas como o
    // estágio já é "respondeu", a varredura de aquecimento frio nunca pega
    // esse lead (ver listarLeadsDevidos: exclui estagio IN ('respondeu',...)).
    assert.equal(lead?.automacao_ativa, 1);
  });
});
