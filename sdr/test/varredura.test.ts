import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirAmbiente, type Ambiente } from './ajuda.ts';
import { ulid } from '../src/lib/ids.ts';
import { varrerLeadsDevidos } from '../src/domain/mensagens.ts';
import { personaPadrao } from '../src/domain/config.ts';
import { regrasPadrao } from '../src/domain/regras.ts';
import { criarAuditor } from '../src/lib/auditoria.ts';

/**
 * A varredura automática (temporizador, a cada N minutos) e o botão manual
 * "Disparar varredura agora" chamam a mesma função de processamento. Sem
 * uma trava de reentrância, as duas podem rodar ao mesmo tempo, ambas
 * listarem o mesmo lead como "devido" (nenhuma ainda atualizou o próximo
 * passo) e mandarem a mesma mensagem em duplicidade — foi exatamente o que
 * aconteceu em produção. Este teste dispara duas varreduras concorrentes
 * (via Promise.all, sem gap de rede) e confirma que só uma de fato
 * processa os leads devidos; a outra é ignorada de bandeja.
 */

async function criarLeadDevido(amb: Ambiente, userId: string, telefone: string): Promise<string> {
  const id = ulid();
  const agora = new Date().toISOString();
  await amb.db.run(
    `INSERT INTO leads
       (id, nome, telefone, estagio, automacao_ativa, sequencia_passo, criado_por, criado_em, atualizado_em)
     VALUES (?, 'Cliente Teste', ?, 'novo', 1, 0, ?, ?, ?)`,
    [id, telefone, userId, agora, agora],
  );
  return id;
}

describe('trava de reentrância da varredura', () => {
  let amb: Ambiente;
  let userId: string;
  before(async () => {
    amb = await subirAmbiente();
    userId = await amb.criarUsuario({ email: 'admin@teste.com', papel: 'admin' });
  });
  after(async () => { await amb.fechar(); });

  test('duas chamadas concorrentes não processam o mesmo lead duas vezes', async () => {
    await criarLeadDevido(amb, userId, '5511900000002');

    const auditor = criarAuditor(amb.db);
    const persona = personaPadrao();
    const regras = regrasPadrao();
    const cfgWhatsapp = { modo: 'simulado' as const, token: null, phoneNumberId: null, verifyToken: null, apiVersion: 'v20.0' };

    const [r1, r2] = await Promise.all([
      varrerLeadsDevidos(amb.db, persona, regras, amb.cfg.ia, cfgWhatsapp, auditor),
      varrerLeadsDevidos(amb.db, persona, regras, amb.cfg.ia, cfgWhatsapp, auditor),
    ]);

    const total = r1.length + r2.length;
    assert.equal(total, 1, `esperava só 1 processamento no total entre as duas chamadas, veio ${total}`);
    assert.ok(r1.length === 0 || r2.length === 0, 'uma das duas chamadas deveria ter sido ignorada (lista vazia)');
  });
});
