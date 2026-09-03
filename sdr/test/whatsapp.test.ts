import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarTelefone, verificarWebhook, extrairMensagensInbound, enviar, enviarTemplate,
} from '../src/integracoes/whatsapp.ts';

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
