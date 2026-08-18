# Operação

Procedimentos de rotina. Todos assumem que você está no diretório do
`docker-compose.yml`.

---

## Comandos do dia a dia

```bash
docker compose ps                 # estado dos serviços
docker compose logs -f app        # log da aplicação (JSON estruturado)
docker compose restart app        # reiniciar só a aplicação
docker compose down               # parar tudo (dados preservados nos volumes)
```

O log sai em JSON, uma linha por evento, com `ts`, `nivel` e `requestId`.
Para filtrar erros:

```bash
docker compose logs app | grep '"nivel":"erro"'
```

Cada resposta HTTP carrega o cabeçalho `X-Request-Id`. Quando um usuário
relata um erro, peça o código exibido na tela e busque por ele no log.

---

## Backup

O serviço `backup` gera um dump diário em `./backups/`, com retenção de 14
dias. Confira que está funcionando:

```bash
ls -lh backups/ | tail -5
```

### Backup manual antes de qualquer mudança

```bash
docker compose exec -T db pg_dump -U comercial comercial \
  | gzip > backups/manual-$(date +%Y%m%d-%H%M).sql.gz
```

### Restauração

```bash
docker compose stop app
gunzip -c backups/comercial-AAAAMMDD-HHMM.sql.gz \
  | docker compose exec -T db psql -U comercial -d comercial
docker compose start app
```

### SQLite

Com `docker-compose.sqlite.yml`, o backup é copiar o arquivo. Pare a
aplicação antes, para garantir que o WAL foi consolidado:

```bash
docker compose stop app
docker run --rm -v painel_dados-app:/d -v "$PWD/backups:/b" alpine \
  sh -c 'cp /d/app.db /b/app-$(date +%Y%m%d).db'
docker compose start app
```

> **A `SECRET_KEY` precisa ser guardada junto do procedimento de restauração,
> em local separado do backup.** Sem ela, o banco restaurado é inútil: nenhuma
> senha valida. Com as duas no mesmo lugar, o pepper deixa de proteger.

---

## Atualização

```bash
docker compose exec -T db pg_dump -U comercial comercial | gzip > backups/pre-update.sql.gz
git pull
docker compose build app
docker compose up -d app
docker compose logs -f app     # confirme "servidor no ar" e as migrations
```

Migrations rodam sozinhas no boot e são idempotentes: só aplica o que falta.

---

## Rotina mensal

1. **Importar a base nova.** Aba *Importar base*, quatro planilhas do período.
   Confira a prévia antes de publicar — o sistema alerta quando algum número
   cai mais de 50% em relação à base atual, o que normalmente indica
   exportação incompleta, não queda real.
2. **Revisar consultores novos.** A prévia lista nomes que apareceram pela
   primeira vez. Oculte os que não são pessoas.
3. **Revisar acessos.** Aba *Auditoria*: contas sem login há mais de 60 dias
   e picos de `login.falha`.
4. **Conferir backups.** `ls -lh backups/`.

---

## Diagnóstico

### A aplicação não sobe

```bash
docker compose logs app | tail -30
```

Erros de configuração são explícitos e aparecem como `Falha ao iniciar:`.
Os mais comuns:

| Mensagem | Causa |
|---|---|
| `SECRET_KEY é obrigatória em produção` | falta a variável no `.env` |
| `SECRET_KEY deve ter no mínimo 32 caracteres` | chave curta |
| `Em produção, APP_URL deve usar https` | `APP_URL` com `http://` |
| `DATABASE_URL inválida` | formato errado da URL |

### Login não funciona, sem mensagem de erro

Quase sempre é cookie. Confira que `APP_URL` bate **exatamente** com o
endereço digitado no navegador, incluindo `https://` e sem barra no fim. O
cookie de sessão usa o prefixo `__Host-`, que o navegador só aceita sob
HTTPS — atrás de proxy sem TLS, ele é descartado em silêncio.

### "Origem da requisição não autorizada"

`APP_URL` diferente do domínio real, ou o proxy não está repassando o
cabeçalho `Origin`. Confira o `Caddyfile`.

### Importação recusada

O sistema mostra o motivo. Os dois casos frequentes:

- **"Não reconheci esta planilha"** — a exportação veio com colunas
  faltando. O erro lista quais. Reexporte do CRM com todas as colunas.
- **"O rateio das vendas não fecha"** — o extrato veio filtrado por vendedor,
  então uma das metades de alguma venda dividida ficou de fora. Reexporte sem
  filtro de vendedor. O erro identifica o contrato.

### Banco lento

```bash
docker compose exec db psql -U comercial -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"
```

A tabela `auditoria` é a que mais cresce. Se estiver grande demais, reduza
`RETENCAO_AUDITORIA_DIAS` — respeitando o mínimo de seis meses do Marco Civil
— e rode a limpeza:

```bash
docker compose exec app node --experimental-strip-types src/main.ts limpar
```

---

## Recuperar acesso de administrador

Se ninguém conseguir entrar como admin, crie outro pela linha de comando:

```bash
docker compose exec app node --experimental-strip-types src/main.ts \
  criar-admin novo-admin@empresa.com.br
```

A senha provisória aparece no terminal, uma única vez.

Se o e-mail já existir e a conta estiver bloqueada:

```bash
docker compose exec db psql -U comercial -c \
  "UPDATE users SET falhas = 0, bloqueado_ate = NULL, ativo = 1
    WHERE email = 'admin@empresa.com.br';"
```

---

## Reverter uma importação errada

Aba *Importar base* → linha marcada como **ATIVA** → **Reverter**. A base
volta para a importação confirmada anterior. Nada é apagado: importações
ficam guardadas e podem ser reativadas.

Tratativas, notas e metas **não** são afetadas por importação nem por
reversão — elas referenciam a oportunidade pelo número, que é estável no CRM.
