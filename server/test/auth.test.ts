import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirAmbiente, SENHA_PADRAO, type Ambiente } from './ajuda.ts';
import { gerarHash, verificarHash, validarPolitica, precisaRehash } from '../src/auth/senha.ts';
import { carregarConfig } from '../src/config.ts';
import { toDollarPlaceholders } from '../src/db/postgres.ts';
import { LimitadorTaxa } from '../src/http/limite.ts';
import { lerCookies, serializarCookie } from '../src/http/servidor.ts';

const SEG = 'segredo-de-teste-com-mais-de-32-caracteres';

describe('hash de senha', () => {
  test('aceita a senha correta e recusa variações', async () => {
    const h = await gerarHash('vela azul no telhado', SEG);
    assert.ok(await verificarHash('vela azul no telhado', h, SEG));
    assert.ok(!(await verificarHash('vela azul no telhad', h, SEG)));
    assert.ok(!(await verificarHash('Vela azul no telhado', h, SEG)));
  });

  test('o pepper torna o hash inútil sem a SECRET_KEY', async () => {
    const h = await gerarHash('vela azul no telhado', SEG);
    assert.ok(!(await verificarHash('vela azul no telhado', h, 'outro-segredo-qualquer-com-32-chars')));
  });

  test('salt aleatório: mesma senha gera hashes diferentes', async () => {
    const a = await gerarHash('vela azul no telhado', SEG);
    const b = await gerarHash('vela azul no telhado', SEG);
    assert.notEqual(a, b);
  });

  test('hash malformado ou hostil não derruba nem trava', async () => {
    for (const ruim of ['', 'lixo', 'scrypt$a$b$c$d$e', `scrypt$99999999$8$1$AAAA$${'A'.repeat(43)}=`]) {
      assert.equal(await verificarHash('x', ruim, SEG), false);
    }
  });

  test('precisaRehash sinaliza formato antigo', () => {
    assert.ok(precisaRehash('scrypt$16384$8$1$AAAA$BBBB'));
    assert.ok(precisaRehash('bcrypt$...'));
  });
});

describe('política de senha', () => {
  test('exige comprimento mínimo', () => {
    assert.ok(!validarPolitica('curta').ok);
    assert.ok(validarPolitica('doze caracteres ok').ok);
  });

  test('recusa senha derivada do e-mail, mesmo sem pontuação', () => {
    const ctx = ['caroline.bortoleto@terra.com', 'Caroline Bortoleto'];
    for (const s of ['carolinebortoleto99', 'Caroline2026!!', 'xxbortoletoxx1']) {
      assert.ok(!validarPolitica(s, ctx).ok, `deveria recusar "${s}"`);
    }
  });

  test('recusa sequências óbvias', () => {
    assert.ok(!validarPolitica('abcdefghijkl').ok);
    assert.ok(!validarPolitica('aaaaaaaaaaaaaa').ok);
  });
});

describe('configuração', () => {
  test('produção sem HTTPS é recusada', () => {
    assert.throws(
      () => carregarConfig({ NODE_ENV: 'production', APP_URL: 'http://x.com', SECRET_KEY: 'a'.repeat(40) } as NodeJS.ProcessEnv),
      /https/i,
    );
  });

  test('produção sem SECRET_KEY é recusada', () => {
    assert.throws(
      () => carregarConfig({ NODE_ENV: 'production', APP_URL: 'https://x.com' } as NodeJS.ProcessEnv),
      /SECRET_KEY/,
    );
  });

  test('SECRET_KEY curta é recusada', () => {
    assert.throws(
      () => carregarConfig({ NODE_ENV: 'production', APP_URL: 'https://x.com', SECRET_KEY: 'curta' } as NodeJS.ProcessEnv),
      /32/,
    );
  });
});

describe('utilitários HTTP', () => {
  test('placeholders viram $n sem tocar em literais', () => {
    assert.equal(toDollarPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
      'SELECT * FROM t WHERE a = $1 AND b = $2');
    assert.equal(toDollarPlaceholders("SELECT '?' , ? FROM t"), "SELECT '?' , $1 FROM t");
    assert.equal(toDollarPlaceholders(`SELECT "col?" , ? FROM t`), `SELECT "col?" , $1 FROM t`);
  });

  test('cookie de sessão sai com as flags de segurança', () => {
    const s = serializarCookie({ nome: '__Host-sessao', valor: 'abc', httpOnly: true, secure: true, maxAgeSegundos: 60 });
    assert.match(s, /HttpOnly/);
    assert.match(s, /Secure/);
    assert.match(s, /SameSite=Strict/);
    assert.match(s, /Path=\//);
  });

  test('leitura de cookies tolera lixo', () => {
    const c = lerCookies('a=1; b=2; lixo; =3; c=v%C3%A1lido');
    assert.equal(c['a'], '1');
    assert.equal(c['c'], 'válido');
  });

  test('limitador barra após o teto e libera depois da janela', () => {
    const l = new LimitadorTaxa(3, 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) assert.ok(l.verificar('ip', t0 + i).permitido);
    assert.ok(!l.verificar('ip', t0 + 4).permitido);
    assert.ok(l.verificar('ip', t0 + 1500).permitido);
  });

  test('limitador isola chaves diferentes', () => {
    const l = new LimitadorTaxa(1, 1000);
    assert.ok(l.verificar('a', 1000).permitido);
    assert.ok(!l.verificar('a', 1001).permitido);
    assert.ok(l.verificar('b', 1001).permitido);
  });
});

describe('fluxo de autenticação', () => {
  let amb: Ambiente;
  before(async () => {
    amb = await subirAmbiente();
    await amb.criarUsuario({ email: 'a@terra.com', papel: 'admin', nome: 'Admin' });
  });
  after(async () => { await amb?.fechar(); });

  test('bloqueia a conta após 5 tentativas erradas', async () => {
    await amb.criarUsuario({ email: 'alvo@terra.com', papel: 'gestor' });
    const c = amb.cliente();
    for (let i = 0; i < 5; i++) {
      const r = await c.req('POST', '/api/auth/login', { email: 'alvo@terra.com', senha: 'errada-mas-longa' });
      assert.equal(r.status, 401);
    }
    // Com a conta bloqueada, nem a senha certa passa.
    const r = await c.req('POST', '/api/auth/login', { email: 'alvo@terra.com', senha: SENHA_PADRAO });
    assert.equal(r.status, 429);
    assert.match(String(r.corpo.mensagem), /bloqueada/i);
  });

  test('usuário inativo não entra e a mensagem não o distingue', async () => {
    await amb.criarUsuario({ email: 'inativo@terra.com', papel: 'gestor', ativo: false });
    const c = amb.cliente();
    const r = await c.req('POST', '/api/auth/login', { email: 'inativo@terra.com', senha: SENHA_PADRAO });
    assert.equal(r.status, 401);
    assert.equal(r.corpo.mensagem, 'E-mail ou senha incorretos.');
  });

  test('logout invalida a sessão de verdade', async () => {
    const c = amb.cliente();
    await c.login('a@terra.com');
    assert.equal((await c.req('GET', '/api/auth/eu')).status, 200);
    await c.req('POST', '/api/auth/logout');
    assert.equal((await c.req('GET', '/api/auth/eu')).status, 401);
  });

  test('trocar a senha encerra as outras sessões', async () => {
    await amb.criarUsuario({ email: 'troca@terra.com', papel: 'gestor' });
    const s1 = amb.cliente(); await s1.login('troca@terra.com');
    const s2 = amb.cliente(); await s2.login('troca@terra.com');
    assert.equal((await s2.req('GET', '/api/auth/eu')).status, 200);

    const r = await s1.req('POST', '/api/auth/senha', { atual: SENHA_PADRAO, nova: 'outra frase bem comprida' });
    assert.equal(r.status, 200);
    assert.equal((await s1.req('GET', '/api/auth/eu')).status, 200, 'a sessão que trocou continua');
    assert.equal((await s2.req('GET', '/api/auth/eu')).status, 401, 'as demais caem');
  });

  test('a senha nova passa pela política', async () => {
    await amb.criarUsuario({ email: 'pol@terra.com', papel: 'gestor', nome: 'Fulano' });
    const c = amb.cliente(); await c.login('pol@terra.com');
    const r = await c.req('POST', '/api/auth/senha', { atual: SENHA_PADRAO, nova: 'curta' });
    assert.equal(r.status, 400);
  });

  test('respostas trazem os cabeçalhos de segurança', async () => {
    const c = amb.cliente();
    const r = await c.req('GET', '/api/saude');
    assert.match(String(r.cabecalhos.get('content-security-policy')), /script-src 'self'/);
    assert.ok(!String(r.cabecalhos.get('content-security-policy')).includes('unsafe-inline'));
    assert.equal(r.cabecalhos.get('x-content-type-options'), 'nosniff');
    assert.equal(r.cabecalhos.get('x-frame-options'), 'DENY');
  });

  test('traversal em arquivo estático não escapa do diretório', async () => {
    const c = amb.cliente();
    for (const alvo of ['/assets/..%2f..%2fsrc%2fconfig.ts', '/assets/....//config.ts']) {
      const r = await c.req('GET', alvo);
      assert.ok(r.status === 404 || r.status === 400, `${alvo} devolveu ${r.status}`);
    }
  });

  test('corpo JSON malformado vira 400, não 500', async () => {
    const r = await fetch(`${amb.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: amb.base },
      body: '{isso não é json',
    });
    assert.equal(r.status, 400);
  });

  test('método errado devolve 405', async () => {
    const c = amb.cliente();
    assert.equal((await c.req('GET', '/api/auth/login')).status, 405);
  });
});

describe('HEAD', () => {
  let amb: Ambiente;
  before(async () => { amb = await subirAmbiente(); });
  after(async () => { await amb?.fechar(); });

  test('HEAD responde como GET, com cabeçalhos e sem corpo', async () => {
    const r = await fetch(`${amb.base}/api/saude`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '', 'HEAD não deve ter corpo');
    assert.ok(Number(r.headers.get('content-length')) > 0, 'Content-Length é o do GET');
    assert.match(String(r.headers.get('content-security-policy')), /default-src/);
  });

  test('HEAD em rota inexistente continua 404', async () => {
    const r = await fetch(`${amb.base}/api/nao-existe`, { method: 'HEAD' });
    assert.equal(r.status, 404);
  });
});
