import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarTelefone, verificarWebhook, extrairMensagensInbound, extrairStatusMensagens,
  enviar, enviarTemplate,
} from '../src/integracoes/whatsapp.ts';
import { subirAmbiente, type Ambiente } from './ajuda.ts';
import { atualizarStatusEntrega } from '../src/domain/leads.ts';
import { ulid } from '../src/lib/ids.ts';

describe('normalização de telefone', () => {
  test('remove tudo que não é dígito', () => {
    assert.equal(normalizarTelefone('+55 (11) 99999-9999'), '5511999999999');
  });
});

describe('verificação do webhook', () => {
  test('devolve o challenge quando o token bate', () => {
    const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'segredo', 'hub.challenge': 'abc123' });
    assert.equal(verificarWebhook(q, 'segredo'), 'abc123');
  });

  test('recusa token errado', () => {
    const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'abc123' });
    assert.equal(verificarWebhook(q, 'segredo'), null);
  });

  test('recusa quando não há verify token configurado', () => {
    const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'segredo', 'hub.challenge': 'abc123' });
    assert.equal(verificarWebhook(q, null), null);
  });
});

describe('extração de mensagens inbound', () => {
  test('lê mensagem de texto do payload real da Cloud API', () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            messages: [{ from: '5511999999999', id: 'wamid.abc', type: 'text', text: { body: 'oi' } }],
          },
        }],
      }],
    };
    const out = extrairMensagensInbound(payload);
    assert.deepEqual(out, [{ telefone: '5511999999999', texto: 'oi', idExterno: 'wamid.abc' }]);
  });

  test('ignora eventos que não são mensagem de texto', () => {
    const payload = { entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] };
    assert.deepEqual(extrairMensagensInbound(payload), []);
  });

  test('payload malformado não lança, devolve lista vazia', () => {
    assert.deepEqual(extrairMensagensInbound(null), []);
    assert.deepEqual(extrairMensagensInbound({}), []);
    assert.deepEqual(extrairMensagensInbound({ entry: 'não é array' }), []);
  });
});

describe('modo simulado', () => {
  test('não faz chamada de rede e devolve sucesso simulado (texto livre)', async () => {
    const r = await enviar(
      { modo: 'simulado', token: null, phoneNumberId: null, verifyToken: null, apiVersion: 'v20.0' },
      '5511999999999', 'oi',
    );
    assert.deepEqual(r, { ok: true, simulado: true, idExterno: null });
  });

  test('não faz chamada de rede e devolve sucesso simulado (modelo)', async () => {
    const r = await enviarTemplate(
      { modo: 'simulado', token: null, phoneNumberId: null, verifyToken: null, apiVersion: 'v20.0' },
      '5511999999999', 'abertura_evento', 'pt_BR', ['Fulano'],
    );
    assert.deepEqual(r, { ok: true, simulado: true, idExterno: null });
  });
});

describe('extração de status de entrega (o "✓✓ azul" de verdade)', () => {
  test('lê sent/delivered/read/failed do payload real da Cloud API', () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            statuses: [
              { id: 'wamid.1', status: 'sent' },
              { id: 'wamid.2', status: 'delivered' },
              { id: 'wamid.3', status: 'read' },
              { id: 'wamid.4', status: 'failed' },
            ],
          },
        }],
      }],
    };
    assert.deepEqual(extrairStatusMensagens(payload), [
      { idExterno: 'wamid.1', status: 'enviada' },
      { idExterno: 'wamid.2', status: 'entregue' },
      { idExterno: 'wamid.3', status: 'lida' },
      { idExterno: 'wamid.4', status: 'falhou' },
    ]);
  });

  test('ignora status desconhecido e evento sem id', () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ status: 'sent' }, { id: 'x', status: 'algo_novo' }] } }] }],
    };
    assert.deepEqual(extrairStatusMensagens(payload), []);
  });

  test('payload sem statuses (ex.: evento de mensagem recebida) não lança', () => {
    assert.deepEqual(extrairStatusMensagens({ entry: [{ changes: [{ value: { messages: [] } }] }] }), []);
    assert.deepEqual(extrairStatusMensagens(null), []);
  });
});

describe('aplicar status de entrega no banco', () => {
  let amb: Ambiente;
  before(async () => { amb = await subirAmbiente(); });
  after(async () => { await amb.fechar(); });

  async function criarLeadEMensagem(idExterno: string) {
    const userId = await amb.criarUsuario({ email: `u${ulid()}@teste.com`, papel: 'admin' });
    const leadId = ulid();
    const agora = new Date().toISOString();
    await amb.db.run(
      `INSERT INTO leads (id, nome, telefone, estagio, criado_por, criado_em, atualizado_em)
       VALUES (?, 'Fulano', ?, 'novo', ?, ?, ?)`,
      [leadId, ulid(), userId, agora, agora],
    );
    const msgId = ulid();
    await amb.db.run(
      `INSERT INTO mensagens (id, lead_id, direcao, canal, texto, gerada_por_ia, status, mensagem_externa_id, criado_em)
       VALUES (?, ?, 'saida', 'whatsapp', 'oi', 0, 'enviada', ?, ?)`,
      [msgId, leadId, idExterno, agora],
    );
    return msgId;
  }

  async function statusDe(msgId: string): Promise<string | null> {
    const r = await amb.db.get<{ entrega_status: string | null }>(
      'SELECT entrega_status FROM mensagens WHERE id = ?', [msgId],
    );
    return r?.entrega_status ?? null;
  }

  test('avança enviada -> entregue -> lida', async () => {
    const msgId = await criarLeadEMensagem('wamid.a');
    await atualizarStatusEntrega(amb.db, 'wamid.a', 'enviada');
    assert.equal(await statusDe(msgId), 'enviada');
    await atualizarStatusEntrega(amb.db, 'wamid.a', 'entregue');
    assert.equal(await statusDe(msgId), 'entregue');
    await atualizarStatusEntrega(amb.db, 'wamid.a', 'lida');
    assert.equal(await statusDe(msgId), 'lida');
  });

  test('evento atrasado (delivered depois de read) não regride o status', async () => {
    const msgId = await criarLeadEMensagem('wamid.b');
    await atualizarStatusEntrega(amb.db, 'wamid.b', 'lida');
    await atualizarStatusEntrega(amb.db, 'wamid.b', 'entregue');
    assert.equal(await statusDe(msgId), 'lida');
  });

  test('id externo desconhecido não lança nem afeta outras mensagens', async () => {
    await criarLeadEMensagem('wamid.c');
    await assert.doesNotReject(atualizarStatusEntrega(amb.db, 'wamid.nao-existe', 'lida'));
  });
});
