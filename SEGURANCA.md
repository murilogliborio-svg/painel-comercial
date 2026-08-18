# Segurança

Este documento registra as decisões, os motivos e o que fazer quando algo dá
errado. Não é uma lista de boas práticas genéricas: descreve o que este
sistema faz, onde está no código e como verificar.

---

## Modelo de ameaça

O que o sistema guarda: nome, telefone e evento de clientes finais (noivos,
aniversariantes), performance individual de colaboradores e valores de
contrato. Sob a LGPD, os dois primeiros são dado pessoal de terceiro.

Ameaças consideradas, em ordem de probabilidade real:

1. **Consultor curioso** tentando ver a carteira ou o resultado de um colega.
2. **Credencial vazada** — senha fraca, reaproveitada ou anotada.
3. **Ex-colaborador** com acesso ainda ativo depois do desligamento.
4. **Captura de sessão** em rede compartilhada.
5. **XSS via dado do CRM** — nome de cliente contendo `<script>`.
6. **CSRF** a partir de outro site com a sessão aberta.
7. **Força bruta** contra o login.

Fora de escopo: invasor com acesso ao servidor (aí o jogo já acabou) e
ataque direcionado por adversário com recursos de Estado.

---

## Controles

### Senha — `src/auth/senha.ts`

**scrypt** (RFC 7914) com N=2¹⁶, r=8, p=1: cerca de 64 MiB de memória e
~170 ms por verificação, medido. Dentro da recomendação do OWASP e caro o
bastante para inviabilizar ataque em GPU.

Argon2id seria a primeira escolha, mas exige dependência nativa compilada.
Para um sistema que precisa subir em qualquer servidor sem toolchain, scrypt
com parâmetros corretos é a alternativa defensável — e vem do próprio Node,
com implementação auditada. Trocar por argon2 é mudança localizada: mantenha
o formato `algo$params$salt$hash` e `precisaRehash()` migra os usuários
existentes de forma transparente no próximo login.

Camadas:

- **Salt** de 16 bytes por usuário.
- **Pepper**: HMAC-SHA256 com a `SECRET_KEY`, que vive no ambiente e não no
  banco. Um dump do banco, sozinho, não permite ataque de dicionário offline.
- **Comparação em tempo constante** (`timingSafeEqual`).
- **Custo constante para e-mail inexistente** (`verificarDummy`): medido em
  174 ms para verificação real contra 166 ms para o caso falso. Sem isso, a
  diferença de tempo permitiria enumerar contas válidas.
- **Teto de sanidade** nos parâmetros lidos do hash: um registro adulterado
  com N gigante viraria negação de serviço.

Política (NIST SP 800-63B): mínimo de 12 caracteres, sem exigência de
composição — regras do tipo "1 maiúscula e 1 símbolo" produzem senhas piores
e previsíveis. Bloqueadas: sequências óbvias, caractere repetido e senha
derivada do próprio nome ou e-mail, comparando os dois lados reduzidos a
letras e dígitos (`caroline.bortoleto@...` pega `carolinebortoleto99`).

### Sessão — `src/auth/sessao.ts`

**Token opaco com estado no servidor, não JWT.** JWT dispensa consulta ao
banco, mas o preço é não haver revogação real: um token roubado vale até
expirar. Aqui "desligar o acesso de alguém agora" é requisito, não
conveniência — e é um `UPDATE`.

- Cookie com 256 bits aleatórios; o banco guarda apenas o SHA-256.
- `HttpOnly`, `SameSite=Strict`, `Secure` sob HTTPS, prefixo `__Host-`.
- **Duas expirações**: absoluta (12 h) e por inatividade (60 min). A primeira
  impede sessão eterna de quem usa o sistema todo dia; a segunda fecha a
  estação esquecida aberta no balcão.
- Trocar a senha **encerra as demais sessões** — se a troca foi por suspeita
  de vazamento, manter as outras abertas anularia o efeito.
- Desativar um usuário revoga tudo dele imediatamente.

> **Detalhe que já causou bug e está documentado no código:** o prefixo
> `__Host-` só é aceito pelo navegador junto com a flag `Secure`. Como
> `Secure` depende de HTTPS, os nomes de cookie acompanham o protocolo
> (`config.ts`). Fixar o prefixo em ambiente HTTP faz o navegador **descartar
> o cookie em silêncio** e o login para de funcionar sem nenhuma mensagem.

### Autorização — `src/auth/contexto.ts`

A regra central do sistema:

```ts
escopoConsultor(req)  →  papel 'consultor'      → o próprio consultor_id
                         papel 'gestor'/'admin' → null (sem restrição)
```

O valor entra no **WHERE do SQL**, nunca em `.filter()` depois da consulta e
nunca no frontend. Um consultor que passe `?consultor=<outro>` recebe **403**,
não uma lista vazia: falhar em voz alta é melhor do que parecer que o dado
não existe.

As abas escondidas na interface são conveniência visual. A autorização real
está no servidor e é o que `test/isolamento.test.ts` verifica — inclusive
tentando escrever em oportunidade alheia e ler notas de outro consultor.

### CSRF — `src/auth/sessao.ts` e `src/app.ts`

Duas barreiras independentes para todo método que altera estado:

1. **Token sincronizado**: valor aleatório preso à sessão no servidor
   (`sessoes.csrf_hash`), ecoado pelo frontend no cabeçalho `X-CSRF-Token`,
   comparado em tempo constante.
2. **Verificação de `Origin`/`Referer`** contra a origem pública. Não depende
   de JavaScript e cobre o caso de o token vazar.

Somado a `SameSite=Strict`, são três camadas.

### XSS — `web/assets/app.js` e `src/http/servidor.ts`

- **CSP sem `unsafe-inline`**: `script-src 'self'; style-src 'self'`.
  Consequência prática: não existe `<script>` nem `style=` inline em lugar
  nenhum do frontend. É o que transforma a CSP de enfeite em barreira real.
  Larguras variáveis de gráfico são aplicadas via CSSOM depois da criação do
  nó, justamente para respeitar isso.
- **Nada entra no DOM por `innerHTML`.** Nome de cliente, observação e nota
  são conteúdo de terceiro e entram sempre por `textContent`. O helper `el()`
  existe para tornar isso o caminho de menor esforço.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `Referrer-Policy: same-origin`.

### Força bruta — `src/http/limite.ts`

- **Por conta**: 5 tentativas → bloqueio de 15 min. Nem a senha correta passa
  durante o bloqueio.
- **Por IP**: 20 tentativas de login por 15 min.
- **Global**: 600 leituras e 120 escritas por minuto por IP.
- Mensagem **idêntica** para usuário inexistente, senha errada e conta
  inativa. Qualquer diferenciação vira ferramenta de enumeração.

### Upload — `src/app.ts`

- Só `.xlsx`, verificado pela **assinatura de ZIP** (`50 4b 03 04`), não pela
  extensão.
- Teto de 25 MB por arquivo, checado **a cada pedaço** recebido — um cliente
  pode mentir no `Content-Length`.
- Máximo de 8 arquivos por importação; a área de espera é por sessão e expira
  em 30 min.
- O parser recusa entrada malformada com erro tipado, e o leitor de XLSX tem
  teto de linhas e colunas contra planilha construída para estourar memória.

O upload usa `application/octet-stream` com o nome no cabeçalho, em vez de
`multipart/form-data`. Um arquivo por requisição elimina a necessidade de um
parser de multipart — que é uma classe conhecida de bugs de segurança — sem
perder nada funcionalmente.

### SQL Injection

Todas as consultas usam **placeholders parametrizados**. Não há concatenação
de valor em SQL em lugar nenhum. Listas dinâmicas (`IN (?, ?, ?)`) geram os
placeholders a partir do **tamanho** do array, nunca do conteúdo.

### Traversal de arquivo — `src/app.ts`

O caminho é normalizado e obrigado a começar dentro do diretório `web/`.
Testado em `test/auth.test.ts`.

---

## Auditoria — `src/lib/auditoria.ts`

Registra login (sucesso e falha), logout, troca e redefinição de senha,
criação e alteração de usuário, importação, **cada acesso a lista nominal**,
tratativas, notas e metas. Guarda quem, quando, de onde e o resultado.

O acesso a lista nominal é auditado porque é o momento em que dado pessoal de
cliente sai do banco — é o que permite responder "quem viu esses dados?"
depois de um incidente ou de um desligamento.

A gravação nunca derruba a operação principal: auditoria que quebra o sistema
vira auditoria desligada.

---

## Resposta a incidente

### Suspeita de credencial comprometida

```bash
# 1. Encerrar todas as sessões e forçar nova senha
docker compose exec db psql -U comercial -c \
  "UPDATE sessoes SET revogado_em = now()::text WHERE user_id =
     (SELECT id FROM users WHERE email = 'pessoa@empresa.com');"
```

Depois, pela interface: **Usuários → Nova senha**. Isso já revoga as sessões e
exige troca no próximo acesso.

### Desligamento de colaborador

Aba **Usuários → Desativar**. A conta perde acesso imediatamente e todas as
sessões caem. **Não apague o usuário**: a trilha de auditoria referencia o id,
e o histórico de quem tratou o quê precisa continuar íntegro.

Depois, em *Consultores da base*, oculte o consultor para tirá-lo das médias.

### Vazamento suspeito de dados

1. `docker compose logs app > incidente.log`
2. Aba **Auditoria**, filtrando por `lista.consultada` e `login.sucesso`, para
   levantar quem acessou o quê e de qual IP.
3. Preserve o backup do dia anterior antes de qualquer alteração.
4. Havendo risco relevante aos titulares, a LGPD (art. 48) exige comunicação à
   ANPD e aos titulares. Ver [LGPD.md](LGPD.md).

### Comprometimento do servidor

Considere **todas as senhas comprometidas**. Gere uma `SECRET_KEY` nova — isso
invalida todos os hashes — e redefina cada usuário. Não reaproveite a chave
antiga.

---

## Verificação periódica

A cada trimestre, ou após qualquer mudança em autenticação:

```bash
cd server
npm test                 # 66 testes; isolamento é o que mais importa
npm run typecheck
```

```bash
# Cabeçalhos de segurança em produção
curl -sI https://seu-dominio | grep -Ei 'content-security|strict-transport|x-frame|x-content'

# Cookie de sessão com todas as flags
curl -si https://seu-dominio/api/auth/login -X POST \
  -H 'Content-Type: application/json' -H "Origin: https://seu-dominio" \
  -d '{"email":"x@y.com","senha":"errada12345"}' | grep -i set-cookie
```

Confira também, na aba Auditoria: contas sem acesso há mais de 60 dias
(candidatas a desativação) e picos de `login.falha`.

---

## Ao alterar o código

- Rota nova que devolve dado de cliente: passe por `escopoConsultor()` **e**
  acrescente o caso em `test/isolamento.test.ts`. O arquivo diz isso no
  cabeçalho, para quem chegar depois.
- Consulta nova: placeholders sempre, sem exceção.
- Elemento novo no frontend: `textContent`, nunca `innerHTML`.
- Dependência npm nova: pense duas vezes. O projeto tem zero por decisão, e
  cada uma que entra é superfície que alguém terá de auditar e atualizar.
