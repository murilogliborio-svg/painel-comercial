/**
 * Ponto de entrada. Sobe o servidor, aplica migrations, agenda manutenção e
 * trata encerramento gracioso.
 *
 * Também expõe subcomandos de operação:
 *   node src/main.ts migrar        aplica migrations e sai
 *   node src/main.ts criar-admin   cria o primeiro administrador
 *   node src/main.ts limpar        expurga auditoria e sessões vencidas
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { carregarConfig } from './config.ts';
import { connect, migrate, type Db } from './db/index.ts';
import { criarServidor } from './http/servidor.ts';
import { montarApp } from './app.ts';
import { limparSessoes } from './auth/sessao.ts';
import { expurgarAuditoria } from './lib/auditoria.ts';
import { gerarHash, validarPolitica } from './auth/senha.ts';
import { ulid, senhaProvisoria } from './lib/ids.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR_WEB = join(AQUI, '..', 'web');

function log(linha: Record<string, unknown>): void {
  // Log estruturado em JSON: agregável por qualquer coletor sem parser próprio.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...linha }) + '\n');
}

async function criarAdmin(db: Db, segredo: string, email?: string, senha?: string): Promise<void> {
  const mail = (email ?? process.env.ADMIN_EMAIL ?? '').toLowerCase().trim();
  if (!mail) throw new Error('Informe o e-mail: node src/main.ts criar-admin <email> [senha]');

  const existente = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [mail]);
  if (existente) throw new Error(`Já existe um usuário com o e-mail ${mail}.`);

  const pw = senha ?? process.env.ADMIN_SENHA ?? senhaProvisoria();
  const pol = validarPolitica(pw, [mail]);
  if (!pol.ok) throw new Error(`Senha recusada pela política: ${pol.erros.join(' ')}`);

  const agora = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, email, nome, papel, senha_hash, trocar_senha, pode_escrever, ativo, criado_em, atualizado_em)
     VALUES (?, ?, 'Administrador', 'admin', ?, ?, 1, 1, ?, ?)`,
    [ulid(), mail, await gerarHash(pw, segredo), senha ? 0 : 1, agora, agora],
  );

  process.stdout.write(
    `\nAdministrador criado.\n  e-mail: ${mail}\n  senha:  ${pw}\n` +
    (senha ? '' : '  (senha provisória: será exigida a troca no primeiro acesso)\n') +
    '\nAnote agora. Esta senha não é exibida de novo.\n\n',
  );
}

/**
 * Cria o primeiro administrador na inicialização, a partir de ADMIN_EMAIL e
 * ADMIN_SENHA, quando ainda não existe nenhum.
 *
 * Existe para que a instalação não exija acesso a terminal: em hospedagem
 * gerenciada, o usuário preenche duas variáveis na tela do provedor e o
 * sistema já sobe com uma conta utilizável.
 *
 * A senha informada aqui é tratada como PROVISÓRIA: `trocar_senha` fica
 * ligado e o sistema exige a troca no primeiro acesso. Por isso a política
 * de senha forte não é aplicada a ela — seria um obstáculo numa etapa em que
 * o usuário ainda nem entrou no sistema, e a senha vai ser substituída em
 * seguida de qualquer forma. O mínimo de 8 caracteres barra o descuido óbvio.
 *
 * Roda uma única vez: havendo qualquer administrador ativo, não faz nada.
 */
async function garantirAdmin(db: Db, segredo: string): Promise<void> {
  const admins = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE papel = 'admin' AND ativo = 1",
  );
  if (Number(admins?.n ?? 0) > 0) return;

  const email = (process.env.ADMIN_EMAIL ?? '').toLowerCase().trim();
  const senha = process.env.ADMIN_SENHA ?? '';

  if (!email || !senha) {
    log({
      nivel: 'aviso',
      msg: 'Nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA nas variáveis de '
         + 'ambiente e reinicie, ou rode: node src/main.ts criar-admin <email>',
    });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    log({ nivel: 'erro', msg: `ADMIN_EMAIL não é um e-mail válido: "${email}"` });
    return;
  }
  if (senha.length < 8) {
    log({ nivel: 'erro', msg: 'ADMIN_SENHA precisa ter ao menos 8 caracteres.' });
    return;
  }

  const jaExiste = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (jaExiste) {
    log({ nivel: 'aviso', msg: `Já existe usuário com o e-mail ${email}; nenhum admin foi criado.` });
    return;
  }

  const agora = new Date().toISOString();
  await db.run(
    `INSERT INTO users (id, email, nome, papel, senha_hash, trocar_senha, pode_escrever, ativo, criado_em, atualizado_em)
     VALUES (?, ?, 'Administrador', 'admin', ?, 1, 1, 1, ?, ?)`,
    [ulid(), email, await gerarHash(senha, segredo), agora, agora],
  );
  log({
    nivel: 'info',
    msg: `Administrador criado: ${email}. A troca de senha será exigida no primeiro acesso.`,
  });
}

async function principal(): Promise<void> {
  const cfg = carregarConfig();
  const db = await connect(cfg.databaseUrl);
  const comando = process.argv[2];

  const aplicadas = await migrate(db, (m) => log({ nivel: 'info', msg: m }));
  if (aplicadas.length) log({ nivel: 'info', msg: 'migrations aplicadas', migrations: aplicadas });

  if (comando === 'migrar') {
    log({ nivel: 'info', msg: 'schema em dia' });
    await db.close();
    return;
  }

  if (comando === 'criar-admin') {
    await criarAdmin(db, cfg.segredoSenha, process.argv[3], process.argv[4]);
    await db.close();
    return;
  }

  if (comando === 'limpar') {
    const s = await limparSessoes(db);
    const a = await expurgarAuditoria(db, cfg.retencaoAuditoriaDias);
    log({ nivel: 'info', msg: 'manutenção concluída', sessoesRemovidas: s, auditoriaRemovida: a });
    await db.close();
    return;
  }

  await garantirAdmin(db, cfg.segredoSenha);

  const { roteador } = montarApp(db, cfg, DIR_WEB);
  const servidor = criarServidor({
    roteador,
    https: cfg.https,
    confiarProxy: cfg.confiarProxy,
    maxJsonBytes: cfg.upload.maxJsonBytes,
    maxUploadBytes: cfg.upload.maxBytes,
    origemPublica: cfg.origemPublica,
    aoLogar: (l) => { if (l['nivel'] !== 'acesso' || cfg.ambiente !== 'producao' || Number(l['status']) >= 400) log(l); },
  });

  // Um cliente lento não deve segurar conexão indefinidamente.
  servidor.headersTimeout = 20_000;
  servidor.requestTimeout = 120_000;
  servidor.keepAliveTimeout = 65_000;

  const manutencao = setInterval(() => {
    void (async () => {
      try {
        const s = await limparSessoes(db);
        const a = await expurgarAuditoria(db, cfg.retencaoAuditoriaDias);
        if (s || a) log({ nivel: 'info', msg: 'manutenção', sessoes: s, auditoria: a });
      } catch (e) {
        log({ nivel: 'erro', msg: 'manutenção falhou', erro: String(e) });
      }
    })();
  }, 6 * 3_600_000);
  manutencao.unref();

  await new Promise<void>((resolve) => servidor.listen(cfg.porta, cfg.host, resolve));
  log({
    nivel: 'info', msg: 'servidor no ar',
    porta: cfg.porta, ambiente: cfg.ambiente, banco: db.dialect, url: cfg.origemPublica,
  });

  let encerrando = false;
  const encerrar = (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    log({ nivel: 'info', msg: 'encerrando', sinal });
    clearInterval(manutencao);
    servidor.close(() => {
      void db.close().then(() => process.exit(0));
    });
    // Se conexões abertas não fecharem, força a saída.
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));
}

principal().catch((e) => {
  process.stderr.write(`\nFalha ao iniciar: ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
