# Painel Comercial

Aplicação web com autenticação individual em que cada consultor enxerga
apenas a própria carteira, e o gestor enxerga o time inteiro. A base é
alimentada pelo upload das planilhas exportadas do CRM.

---

## O que já está pronto e verificado

A suíte roda em qualquer clone com Node 22.6+, sem instalar nada:

```
cd server
npm test        # 66 testes
npm run typecheck
```

Resultado na bancada de desenvolvimento: **66/66 testes, 0 erros de tipo**.

O que os testes cobrem, em ordem de importância:

| Arquivo | O que prova |
|---|---|
| `test/isolamento.test.ts` | Um consultor autenticado **não** alcança dado de outro — nem pela URL, nem forçando parâmetro, nem escrevendo em oportunidade alheia. 14 casos. |
| `test/auth.test.ts` | Hash de senha, bloqueio por tentativa, política, sessão, CSRF, cabeçalhos, traversal de arquivo. |
| `test/etl.test.ts` | Leitura das planilhas e a regra de rateio de venda dividida. |

O sistema foi executado ponta a ponta em navegador com as planilhas reais:
login, importação, publicação da base, painel do gestor, painel do consultor
e listas nominais.

### O que NÃO foi executado

O adaptador **PostgreSQL** (`src/db/postgres.ts`) é o único módulo que
depende de pacote npm (`pg`) e não pôde ser executado no ambiente onde o
restante foi desenvolvido e testado — não havia acesso ao registro npm nem a
um servidor PostgreSQL. Todo o resto roda sobre SQLite, inclusive os testes.

**Antes do primeiro deploy em Postgres**, suba um banco e rode:

```bash
cd server && npm install pg
DATABASE_URL=postgres://usuario:senha@localhost:5432/comercial npm run test:db
```

É a mesma suíte; ela apenas troca o adaptador. Se passar, o arquivo está
correto. Está anotado no topo do próprio módulo para quem for revisar.

Se preferir eliminar essa incerteza: **SQLite é uma escolha legítima** para
11 a 50 usuários, está totalmente testado e usa `docker-compose.sqlite.yml`.

---

## Arquitetura

```
navegador ──HTTPS──> Caddy ──HTTP──> app (Node 22) ──> PostgreSQL ou SQLite
                       │                  │
              TLS, HTTP/2, gzip      sessões, RBAC,
              certificado automático  ETL, auditoria
```

**Zero dependências de runtime.** O servidor usa apenas a biblioteca padrão do
Node: `node:http`, `node:crypto`, `node:sqlite`, `node:zlib`. Isso inclui o
leitor de XLSX, escrito em `src/lib/xlsx.ts` (ZIP + XML, ~350 linhas).

A decisão não é purismo. Um sistema que guarda nome e telefone de clientes
tem uma superfície de supply chain que alguém precisa auditar e manter
atualizada; aqui essa superfície é zero, e a única dependência opcional é o
driver do Postgres. O custo é ter escrito ~250 linhas de roteamento e parsing
que um framework daria de graça — legíveis e sob seu controle.

TLS, compressão e HTTP/2 ficam no Caddy, que é software especializado nisso.

### Mapa do código

```
server/src/
├── main.ts              boot, subcomandos (migrar, criar-admin, limpar)
├── app.ts               rotas e middlewares
├── config.ts            configuração validada; recusa subir se insegura
├── http/
│   ├── servidor.ts      roteador, corpo, cabeçalhos de segurança, erros
│   └── limite.ts        rate limit por janela deslizante
├── auth/
│   ├── senha.ts         scrypt + pepper, política de senha
│   ├── sessao.ts        sessões opacas, CSRF, revogação
│   └── contexto.ts      RBAC e escopoConsultor()  ← regra central
├── db/
│   ├── sqlite.ts        adaptador (testado)
│   ├── postgres.ts      adaptador (ver ressalva acima)
│   └── migrations.ts    schema versionado, os dois dialetos
├── domain/
│   ├── etl.ts           planilha → modelo; regra de rateio
│   ├── importar.ts      importação em duas fases, com prévia e reversão
│   └── consultas.ts     consultas do painel, com escopo obrigatório
└── lib/
    ├── xlsx.ts          leitor de XLSX sem dependências
    ├── valores.ts       dinheiro em centavos, datas, normalização
    ├── ids.ts           ULID, tokens, senha provisória
    └── auditoria.ts     trilha de auditoria
```

---

## Instalação

### 1. Pré-requisitos

Docker e Docker Compose, um domínio apontando para o servidor, e portas 80 e
443 liberadas (o Caddy precisa da 80 para emitir o certificado).

### 2. Configurar

```bash
cp .env.example .env
openssl rand -base64 48   # → SECRET_KEY
openssl rand -base64 32   # → POSTGRES_PASSWORD
$EDITOR .env
```

> **A `SECRET_KEY` entra no hash de todas as senhas.** Trocá-la invalida
> todos os logins. Guarde-a fora do backup do banco: se as duas coisas
> vazarem juntas, o pepper deixa de proteger.

### 3. Subir

```bash
docker compose up -d
docker compose logs -f app
```

### 4. Criar o primeiro administrador

```bash
docker compose exec app node --experimental-strip-types src/main.ts \
  criar-admin voce@empresa.com.br
```

A senha provisória aparece **uma única vez** no terminal. O sistema exige a
troca no primeiro acesso.

### 5. Importar a base

Entre como administrador → aba **Importar base** → envie as quatro planilhas
do CRM do mesmo período:

- Oportunidades
- Listagem de Ações
- Degustações Comercial
- Extrato de Vendas

O sistema reconhece cada arquivo pelo cabeçalho (não pelo nome), valida,
mostra o que vai mudar e só publica após a sua confirmação.

### 6. Cadastrar a equipe

Aba **Usuários**:

1. Em *Consultores da base*, **oculte** os nomes que não são pessoas —
   nas suas planilhas: `Equipe V2`, e possivelmente `Pedro Miguel`,
   `Daiane Bigue`, `Murilo Liborio`. Eles saem das médias e do ranking, mas o
   histórico é preservado.
2. Crie um usuário para cada consultor, vinculando ao consultor correspondente.
3. A senha provisória aparece na tela uma única vez — entregue pessoalmente,
   não por WhatsApp nem e-mail.

---

## Perfis de acesso

| Perfil | Enxerga | Pode |
|---|---|---|
| **consultor** | somente a própria carteira | dar baixa em pendência, escrever notas, ver as próprias metas |
| **gestor** | o time inteiro | tudo acima + importar base, definir metas, ver auditoria |
| **admin** | o time inteiro | tudo acima + criar/desativar usuários, redefinir senhas |

Qualquer usuário pode ser marcado como **somente leitura**, mantendo a
visualização e bloqueando a escrita.

---

## A regra de negócio que exige atenção

**Uma venda fechada a quatro mãos é exportada em duas linhas**, cada uma com
metade do valor e `Quantidade = 0,5`. Portanto:

```
valor do contrato       = SOMA das linhas daquele Num Contrato
crédito de um consultor = a linha dele
nº de contratos         = SOMA de Quantidade (0,5 + 0,5 = 1)
```

Ler uma linha isolada como se fosse o contrato inteiro **subestima o
faturamento pela metade**. Deduplicar por contrato e pegar só uma linha,
também.

Nos seus dados, o CT2026-0351 é o caso que denuncia o erro: a linha mostra
R$ 28.548 (R$ 476 por convidado, fora de qualquer padrão da Casa Lucca),
enquanto o contrato é R$ 57.096 (R$ 952 por convidado, coerente com as outras
vendas da casa).

A importação **recusa o arquivo** se a soma das partes de algum contrato não
fechar em 1 — sinal de exportação incompleta. Ver `src/domain/etl.ts` e os
testes em `test/etl.test.ts`.

---

## Operação

```bash
docker compose ps                    # estado dos serviços
docker compose logs -f app           # log estruturado em JSON
docker compose exec app node --experimental-strip-types src/main.ts limpar
                                     # expurga auditoria vencida e sessões mortas
```

Backup do Postgres roda diariamente para `./backups/`, com retenção de 14
dias. Restauração e demais procedimentos em [OPERACAO.md](OPERACAO.md).

Endpoint de saúde: `GET /api/saude`.

---

## Limites conhecidos

- **Uma instância só.** O rate limit é em memória; com duas instâncias atrás
  de um balanceador cada uma aplicaria o próprio teto. Escalar
  horizontalmente exige mover o contador para o banco ou Redis.
- **Sem redefinição de senha por e-mail.** É deliberado: o sistema não envia
  e-mail, e o gestor redefine pela interface. Menos superfície de ataque.
- **Sem exportação para CSV/Excel.** Também deliberado — ver
  [LGPD.md](LGPD.md). Dá para adicionar, mas passa a exigir controle de
  vazamento de dado pessoal.
- **A base é um retrato.** Cada importação substitui a anterior. Tratativas,
  notas e metas sobrevivem, porque referenciam a oportunidade pelo número.

---

## Documentos

- [SEGURANCA.md](SEGURANCA.md) — decisões de segurança e o que fazer num incidente
- [LGPD.md](LGPD.md) — tratamento de dado pessoal, retenção, direitos do titular
- [OPERACAO.md](OPERACAO.md) — backup, restauração, atualização, diagnóstico
