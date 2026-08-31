# SDR de I.A.

Automação de aquecimento de clientes por WhatsApp: uma I.A. escreve e envia
mensagens de aquecimento para leads cadastrados pelo time comercial,
seguindo uma persona e regras configuráveis, até que o lead responda — a
partir daí a conversa vira humana. Serviço independente do
[painel-comercial](../README.md), com login e hospedagem próprios.

---

## O estado real deste projeto — leia antes de mostrar para alguém

Este serviço **funciona ponta a ponta com dados simulados**: login,
cadastro de lead, geração de mensagem por I.A., "envio" e painel de
conversa foram testados. **Nenhuma mensagem real chegou a um WhatsApp de
verdade**, porque isso depende de duas contas que só você pode criar (ver
abaixo). Até lá, o sistema roda em **modo simulado**: grava a mensagem como
enviada, sem tocar em nenhuma API do WhatsApp.

```
cd sdr
npm install         # só as devDependencies (typescript, @types/node)
npm test             # 40 testes
npm run typecheck    # 0 erros
```

O que os testes cobrem:

| Arquivo | O que prova |
|---|---|
| `test/regras.test.ts` | O motor de regras — janela comercial, opt-out, teto de mensagens sem resposta, intervalo mínimo — bloqueia envio em toda situação arriscada. |
| `test/whatsapp.test.ts` | Parsing do payload da Cloud API, verificação de webhook, e que o modo simulado nunca chama a rede. |
| `test/auth.test.ts` | Login, sessão, CSRF, RBAC (comercial não acessa rotas de admin), e que o webhook do WhatsApp — que não é chamado pelo navegador — não é bloqueado por CSRF/Origin. |

### O que falta para "ligar de verdade"

1. **Conta comercial do WhatsApp (Meta Business + Cloud API).** Sem isso
   não existe canal — nenhum software substitui essa etapa, é uma conta que
   sua empresa precisa abrir e verificar. Passo a passo abaixo.
2. **Chave de API da Anthropic**, para a I.A. gerar as mensagens.
3. Decidir a persona e revisar a sequência de aquecimento **com quem
   entende o tom da marca** antes de deixar rodando sozinho — o padrão vem
   com um texto genérico de exemplo.

Sem os itens 1 e 2, o sistema sobe normalmente e o painel funciona; só a
geração de texto e o envio de verdade ficam desligados (ver `main.ts`, que
avisa isso no log ao iniciar).

---

## Como a automação evita ser um robô de spam

Vocês pediram para a I.A. enviar sozinha, sem aprovação humana mensagem a
mensagem — isso só é defensável com barreiras fortes. As barreiras estão em
`src/domain/regras.ts` (funções puras, testadas isoladamente) e são
aplicadas antes de qualquer envio:

- **Horário comercial e dias úteis configuráveis.** Fora disso, não envia.
- **Teto diário global** de mensagens automáticas, somando todos os leads.
- **Intervalo mínimo entre mensagens** ao mesmo lead (padrão: 48h).
- **Sequência curta e finita** (padrão: 3 passos — apresentação, reforço,
  convite). Terminada a sequência, para sozinha.
- **Pausa automática após N mensagens sem resposta** (padrão: 3) — o lead
  fica esperando um humano, não recebe mensagem 10 de uma esteira ignorada.
- **Opt-out por palavra-chave** ("parar", "descadastrar", "não quero
  mais"...) tira o lead da automação permanentemente e é auditado.
- **Qualquer resposta real do lead tira ele da automação.** A partir do
  primeiro "oi" de volta, o estágio vira `respondeu` e só humano manda
  mensagem dali em diante — é o que torna "a I.A. envia sozinha" compatível
  com "sempre humano": o robô cuida só do contato frio antes de existir
  diálogo de verdade.
- **Mensagem manual de um vendedor pausa a automação daquele lead** — não
  há risco de a I.A. escrever por cima de uma conversa humana em andamento.

A persona (tom, nome de quem assina, diretrizes) e todas essas regras são
editáveis pela tela **Configuração** (perfil admin), sem redeploy.

### Sobre "soar sempre humano"

O prompt da I.A. (`src/integracoes/ia.ts`) pede tom natural, curto, sem
linguagem de robô ou call center, e proíbe repetir a mesma abertura entre
mensagens. Isso é sobre **naturalidade**, não sobre disfarce: se um lead
perguntar diretamente se está falando com um robô, a orientação embutida no
prompt é responder com honestidade. Negar seria enganoso e é o tipo de
prática que cria risco de LGPD/CDC — recomendamos manter essa postura.

---

## Arquitetura

Mesmo princípio do painel-comercial: zero dependências de runtime
(`node:http`, `node:crypto`, `node:sqlite`), TypeScript rodando direto via
`--experimental-strip-types`, SQLite (aqui não há adaptador Postgres — o
volume de uma equipe comercial não justifica). As duas integrações externas
(I.A. e WhatsApp) usam `fetch` nativo, sem SDK.

```
sdr/src/
├── main.ts              boot, subcomandos, varredura periódica de aquecimento
├── app.ts                rotas
├── config.ts              configuração validada (inclui I.A. e WhatsApp)
├── http/                  roteador e rate limit — cópia do painel-comercial
├── auth/                  senha (scrypt+pepper), sessão opaca, RBAC (admin/comercial)
├── db/                    SQLite + migrations (users, leads, mensagens, config, auditoria)
├── integracoes/
│   ├── ia.ts               geração de mensagem via API da Anthropic
│   └── whatsapp.ts         Meta Cloud API + modo simulado + parsing de webhook
├── domain/
│   ├── leads.ts            CRUD e consultas
│   ├── regras.ts            motor de guardrails (função pura, testável)
│   ├── config.ts            persona e regras, guardadas no banco (editáveis pela tela)
│   └── mensagens.ts          orquestra regras + I.A. + WhatsApp + auditoria
└── lib/                    ids (ULID), auditoria
```

Não há isolamento por consultor como no painel-comercial: a fila de leads é
do time comercial inteiro, com um campo `responsavel_id` opcional para
indicar quem está cuidando de cada um.

---

## Passo a passo: colocar no ar

### 1. Testar localmente (sem nenhuma credencial externa)

```bash
cd sdr
npm install
ADMIN_EMAIL=voce@empresa.com ADMIN_SENHA="uma senha de teste bem longa" \
  SECRET_KEY="$(openssl rand -base64 48)" APP_URL=http://localhost:8081 \
  npm start
```

Abra `http://localhost:8081`, entre com o admin, cadastre um lead de teste
com um telefone qualquer e dispare "Varredura agora" na aba Configuração.
Como não há `ANTHROPIC_API_KEY`, a geração falha com um aviso claro — é
esperado. Configure a chave para ver o texto sendo gerado de verdade (o
envio continua simulado até você configurar o WhatsApp).

### 2. Conseguir a conta do WhatsApp (Meta Cloud API)

1. Crie/entre em [business.facebook.com](https://business.facebook.com) e
   configure um app com o produto **WhatsApp**.
2. Gere um número de telefone comercial (ou migre o existente) e um token
   de acesso permanente — o token temporário de teste expira em 24h.
3. Anote `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID`.
4. Invente um `WHATSAPP_VERIFY_TOKEN` (qualquer string longa) — você vai
   colar o mesmo valor aqui e na tela de configuração do webhook da Meta.
5. Na configuração do webhook, aponte para
   `https://SEU-DOMINIO/api/whatsapp/webhook` e cole o verify token.
   A Meta faz uma requisição `GET` de verificação; o servidor já sabe
   responder (`src/app.ts`, rota `GET /api/whatsapp/webhook`).
6. Assine o campo `messages` do webhook, para receber as respostas dos
   leads.

Com as três variáveis preenchidas, `config.ts` liga sozinho o modo real —
não existe outro interruptor para esquecer de virar.

**Antes de assinar o webhook em produção**, veja a ressalva de segurança
abaixo sobre validação de assinatura.

### 3. Conseguir a chave da Anthropic

Crie uma chave em [console.anthropic.com](https://console.anthropic.com) e
preencha `ANTHROPIC_API_KEY`. `ANTHROPIC_MODEL` já vem com um padrão razoável.

### 4. Subir

**Docker (VPS própria):**
```bash
cp .env.example .env   # preencha
docker compose up -d
docker compose exec app node --experimental-strip-types src/main.ts \
  criar-admin voce@empresa.com
```

**Render (um clique):** ao criar o Blueprint, aponte para `sdr/render.yaml`
neste repositório (é um serviço independente do `render.yaml` da raiz, que
é do painel-comercial — os dois podem coexistir, cada um com sua URL).

### 5. Cadastrar o time comercial

Aba **Usuários** (perfil admin): crie um usuário por vendedor, perfil
`comercial`. A senha provisória aparece uma única vez na tela — entregue
pessoalmente.

---

## Antes de deixar rodando sozinho de verdade: checklist

- [ ] Testou a esteira inteira em modo simulado (persona, regras, sequência)
      e o texto gerado soa como a empresa, não genérico.
- [ ] Conta WhatsApp Business verificada e número comercial migrado.
- [ ] Webhook configurado e testado (mande uma mensagem de outro número
      para o número comercial e confira que aparece no painel).
- [ ] Revisou a sequência de aquecimento e as diretrizes com quem decide o
      tom da marca — não só com quem decide tecnologia.
- [ ] Confirmou os limites (horário, teto diário, intervalo) com o
      time jurídico/compliance, considerando LGPD e o Marco Civil.
- [ ] Testou opt-out de verdade: responder "parar" tira o lead da
      automação e aparece na auditoria.

---

## Limites conhecidos

- **Assinatura do webhook não verificada.** A Meta assina o corpo do
  webhook com `X-Hub-Signature-256` usando o *app secret*; este serviço não
  confere essa assinatura ainda — qualquer requisição que acerte a URL e o
  formato do payload é aceita como se fosse da Meta. Para produção com
  volume real, adicionar essa checagem em `src/app.ts` (rota
  `POST /api/whatsapp/webhook`) antes de expor o webhook publicamente é
  recomendado. O rate limit da rota (`limiteWebhook` em `app.ts`) reduz o
  risco de abuso enquanto isso não é feito, mas não substitui a assinatura.
- **Uma instância só**, mesmo motivo do painel-comercial: rate limit e a
  varredura de aquecimento vivem em memória do processo.
- **Sem adaptador Postgres.** Se o volume um dia justificar, seguir o
  padrão do painel-comercial (`server/src/db/postgres.ts`) é o caminho.
- **Sem redefinição de senha por e-mail**, de propósito — mesma decisão do
  painel-comercial (ver [SEGURANCA.md](../SEGURANCA.md) lá).

## Documentos relacionados

Este serviço segue os mesmos princípios de segurança e tratamento de dado
pessoal do painel-comercial — ver [SEGURANCA.md](../SEGURANCA.md) e
[LGPD.md](../LGPD.md) na raiz do repositório. A diferença central aqui é
que este sistema **envia** dado para o titular (mensagem de WhatsApp), não
só armazena: opt-out funcional e auditoria de toda mensagem automática são
a parte que atende à LGPD especificamente para isso.
