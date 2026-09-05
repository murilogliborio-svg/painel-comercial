import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirAmbiente, type Ambiente } from './ajuda.ts';
import { gerarHash, verificarHash, validarPolitica } from '../src/auth/senha.ts';

const SEG = 'segredo-de-teste-com-mais-de-32-caracteres';

describe('hash e política de senha', () => {
  test('aceita a senha correta e recusa variações', async () => {
    const h = await gerarHash('vela azul no telhado', SEG);
    assert.ok(await verificarHash('vela azul no telhado', h, SEG));
    assert.ok(!(await verificarHash('vela azul no telhad', h, SEG)));
  });

  test('política recusa senha curta e sequência óbvia', () => {
    assert.ok(!validarPolitica('curta').ok);
    assert.ok(!validarPolitica('abcdefghijkl').ok);
    assert.ok(validarPolitica('uma senha bem razoavel').ok);
  });
});

describe('login e sessão', () => {
  let amb: Ambiente;
  before(async () => { amb = await subirAmbiente(); });
  after(async () => { await amb.fechar(); });

  test('login com credenciais corretas cria sessão e csrf', async () => {
    await amb.criarUsuario({ email: 'vendedor@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    const r = await cli.login('vendedor@teste.com');
    assert.equal(r.status, 200);
    assert.ok(r.corpo.csrf);
    assert.ok(cli.cookies.length > 0);
  });

  test('senha errada não autentica e não vaza se o e-mail existe', async () => {
    await amb.criarUsuario({ email: 'outro@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    const rSenhaErrada = await cli.req('POST', '/api/auth/login', { email: 'outro@teste.com', senha: 'senha-errada-123456' });
    const rInexistente = await cli.req('POST', '/api/auth/login', { email: 'nao-existe@teste.com', senha: 'senha-errada-123456' });
    assert.equal(rSenhaErrada.status, 401);
    assert.equal(rInexistente.status, 401);
    assert.equal(rSenhaErrada.corpo.mensagem, rInexistente.corpo.mensagem);
  });

  test('sem cookie de sessão, rota autenticada devolve 401', async () => {
    const cli = amb.cliente();
    const r = await cli.req('GET', '/api/leads');
    assert.equal(r.status, 401);
  });

  test('requisição de escrita sem token CSRF é recusada', async () => {
    await amb.criarUsuario({ email: 'csrf@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('csrf@teste.com');
    cli.csrf = ''; // csrf válido existe na sessão, mas não é enviado
    const r = await cli.req('POST', '/api/leads', { nome: 'Fulano', telefone: '5511999999999' });
    assert.equal(r.status, 403);
  });
});

describe('RBAC: comercial não acessa rotas de admin', () => {
  let amb: Ambiente;
  before(async () => { amb = await subirAmbiente(); });
  after(async () => { await amb.fechar(); });

  test('comercial não configura persona/regras nem cria usuário', async () => {
    await amb.criarUsuario({ email: 'com@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com@teste.com');

    const rPersona = await cli.req('PUT', '/api/config/persona', {
      nomeEmpresa: 'x', nomeAtendente: 'y', tom: 'z', diretrizes: '',
    });
    assert.equal(rPersona.status, 403);

    const rUsuario = await cli.req('POST', '/api/admin/usuarios', {
      nome: 'Novo', email: 'novo@teste.com', papel: 'comercial',
    });
    assert.equal(rUsuario.status, 403);

    const rAuditoria = await cli.req('GET', '/api/admin/auditoria');
    assert.equal(rAuditoria.status, 403);
  });

  test('comercial CRIA e vê leads normalmente — a fila é do time inteiro', async () => {
    await amb.criarUsuario({ email: 'com2@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com2@teste.com');

    const criado = await cli.req('POST', '/api/leads', { nome: 'Fulano de Tal', telefone: '5511988887777' });
    assert.equal(criado.status, 201);

    const lista = await cli.req('GET', '/api/leads');
    assert.equal(lista.status, 200);
    assert.equal(lista.corpo.leads.length, 1);
  });

  test('excluir lead move pra lixeira (reversível) — some da lista, mensagens continuam intactas', async () => {
    await amb.criarUsuario({ email: 'com3@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com3@teste.com');

    const criado = await cli.req('POST', '/api/leads', { nome: 'Lead Descartável', telefone: '5511977776666' });
    assert.equal(criado.status, 201);
    const id = criado.corpo.lead.id;

    await cli.req('POST', `/api/leads/${id}/mensagens`, { texto: 'mensagem de teste' });
    const antes = await cli.req('GET', `/api/leads/${id}`);
    assert.equal(antes.corpo.mensagens.length, 1);

    const excluido = await cli.req('DELETE', `/api/leads/${id}`);
    assert.equal(excluido.status, 200);

    // Some da lista normal, mas continua acessível por id, com o histórico intacto.
    const listaNormal = await cli.req('GET', '/api/leads');
    assert.ok(!listaNormal.corpo.leads.some((l: { id: string }) => l.id === id));

    const depois = await cli.req('GET', `/api/leads/${id}`);
    assert.equal(depois.status, 200);
    assert.ok(depois.corpo.lead.excluido_em);
    assert.equal(depois.corpo.mensagens.length, 1);

    // Aparece na lixeira.
    const lixeira = await cli.req('GET', '/api/leads?lixeira=1');
    assert.ok(lixeira.corpo.leads.some((l: { id: string }) => l.id === id));

    // Restaurar traz de volta pra lista normal, histórico como estava.
    const restaurado = await cli.req('POST', `/api/leads/${id}/restaurar`);
    assert.equal(restaurado.status, 200);
    const listaDepoisRestaurar = await cli.req('GET', '/api/leads');
    assert.ok(listaDepoisRestaurar.corpo.leads.some((l: { id: string }) => l.id === id));

    // Excluir de novo e apagar permanentemente — aí sim é irreversível.
    await cli.req('DELETE', `/api/leads/${id}`);
    const permanente = await cli.req('DELETE', `/api/leads/${id}/permanente`);
    assert.equal(permanente.status, 200);
    const apos = await cli.req('GET', `/api/leads/${id}`);
    assert.equal(apos.status, 404);

    // Mensagens somem junto (ON DELETE CASCADE) — confirma direto no banco,
    // já que a rota que as listava não existe mais pra esse lead.
    const orfas = await amb.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ?', [id],
    );
    assert.equal(Number(orfas?.n ?? -1), 0);
  });

  test('importação de leads por CSV: cria, pula duplicado, reporta linha inválida', async () => {
    await amb.criarUsuario({ email: 'com5@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com5@teste.com');

    // Um telefone já cadastrado antes da importação, pra confirmar que
    // repetido é pulado (não sobrescreve).
    await cli.req('POST', '/api/leads', { nome: 'Já Existia', telefone: '5511900001111' });

    const csv = [
      'nome,telefone,contexto',
      'Novo Lead Um,5511900002222,quer orçamento de casamento',
      'Já Existia,5511900001111,não deveria duplicar',
      ',5511900003333,sem nome',
    ].join('\n');

    const r = await cli.req('POST', '/api/leads/importar', { csv });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.criados, 1);
    assert.equal(r.corpo.duplicados, 1);
    assert.equal(r.corpo.erros.length, 1);
    assert.match(r.corpo.erros[0].motivo, /nome/);

    const lista = await cli.req('GET', `/api/leads?busca=${encodeURIComponent('Novo Lead Um')}`);
    assert.equal(lista.corpo.leads.length, 1);
    assert.equal(lista.corpo.leads[0].contexto, 'quer orçamento de casamento');
  });

  test('importação sem colunas de nome/telefone reconhecíveis é recusada com mensagem clara', async () => {
    await amb.criarUsuario({ email: 'com6@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com6@teste.com');

    const r = await cli.req('POST', '/api/leads/importar', { csv: 'coluna_a,coluna_b\nx,y\n' });
    assert.equal(r.status, 400);
  });

  test('excluir lead inexistente devolve 404', async () => {
    await amb.criarUsuario({ email: 'com4@teste.com', papel: 'comercial' });
    const cli = amb.cliente();
    await cli.login('com4@teste.com');
    const r = await cli.req('DELETE', '/api/leads/nao-existe');
    assert.equal(r.status, 404);
  });

  test('admin acessa tudo, incluindo configuração', async () => {
    await amb.criarUsuario({ email: 'admin@teste.com', papel: 'admin' });
    const cli = amb.cliente();
    await cli.login('admin@teste.com');

    const rPersona = await cli.req('PUT', '/api/config/persona', {
      nomeEmpresa: 'Casa Exemplo', nomeAtendente: 'Ana', tom: 'caloroso', diretrizes: '',
    });
    assert.equal(rPersona.status, 200);

    const rAuditoria = await cli.req('GET', '/api/admin/auditoria');
    assert.equal(rAuditoria.status, 200);
  });
});

describe('webhook do WhatsApp: rota pública, sem CSRF nem Origin', () => {
  let amb: Ambiente;
  before(async () => { amb = await subirAmbiente(); });
  after(async () => { await amb.fechar(); });

  test('POST no webhook sem cookie nem Origin não é bloqueado por CSRF/Origin', async () => {
    const r = await fetch(`${amb.base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: [] }),
    });
    assert.equal(r.status, 200);
  });
});
