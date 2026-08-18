# LGPD — tratamento de dados pessoais

Este sistema trata dado pessoal de terceiros. Este documento existe para que
o encarregado (DPO) ou o responsável jurídico consiga responder às perguntas
da lei sem precisar ler código.

Não é parecer jurídico. É a descrição técnica do que o sistema faz, para
embasar a avaliação de quem tem competência para dar o parecer.

---

## Que dados são tratados

| Dado | Origem | Titular | Base legal sugerida |
|---|---|---|---|
| Nome do cliente | CRM | cliente final | execução de contrato / legítimo interesse (art. 7º, V e IX) |
| Nº de cliente, oportunidade | CRM | cliente final | idem |
| Tipo e data do evento | CRM | cliente final | idem |
| Nº de convidados | CRM | cliente final | idem |
| Nome e e-mail do colaborador | cadastro interno | colaborador | execução de contrato de trabalho (art. 7º, V) |
| Indicadores de desempenho | derivado do CRM | colaborador | legítimo interesse do empregador (art. 7º, IX) |
| IP e user-agent de acesso | requisição HTTP | colaborador | cumprimento de obrigação legal (art. 7º, II — Marco Civil, art. 15) |

**Não há** dado sensível (art. 5º, II): sem origem racial, religião, opinião
política, saúde, biometria ou orientação sexual. Se algum campo do CRM passar
a carregar esse tipo de informação, reavalie antes de importar.

**Não há** dado de menor. Se o negócio passar a tratar debutantes menores de
idade como titulares diretos, a hipótese do art. 14 precisa ser avaliada.

---

## Princípios do art. 6º, aplicados

**Finalidade e adequação.** Os dados existem para gestão comercial: saber
quem contatar, quando e por quê. Não são usados para outro fim.

**Necessidade.** Cada consultor enxerga **apenas a própria carteira** — é o
controle de minimização mais relevante do sistema, e está no SQL, não na
interface. O gestor vê o time inteiro porque a função exige.

O sistema **não importa nem armazena** telefone, e-mail nem endereço de
cliente, mesmo quando a exportação do CRM traz esses campos: eles não são
necessários para a gestão comercial e sua ausência reduz o impacto de um
eventual vazamento.

**Transparência.** O rodapé da aplicação informa a todo usuário que o acesso é
individual e auditado, e que as listas contêm dado pessoal de cliente.

**Segurança.** Ver [SEGURANCA.md](SEGURANCA.md).

**Prevenção.** Não há exportação para CSV ou Excel na interface, por decisão.
Exportação é o vetor mais comum de vazamento em ferramenta comercial: o
arquivo sai do sistema, perde o controle de acesso e passa a viver em pen
drive, e-mail e WhatsApp. Se o negócio exigir exportação, ela deve nascer
auditada, com marca d'água de quem gerou e aprovação do gestor.

**Responsabilização.** Trilha de auditoria com um ano de retenção, incluindo
cada acesso a lista nominal.

---

## Retenção e eliminação

| Dado | Prazo | Como |
|---|---|---|
| Auditoria | 365 dias (`RETENCAO_AUDITORIA_DIAS`) | expurgo automático a cada 6 h |
| Sessões encerradas | 7 dias | limpeza automática |
| Importações antigas | manual | ver abaixo |
| Notas e tratativas | enquanto útil | remoção lógica pela interface |

O prazo de auditoria dialoga com o art. 15 do Marco Civil da Internet, que
exige a guarda de registros de acesso a aplicação por **seis meses**. Um ano
é uma margem confortável; encurtar abaixo de seis meses não é recomendável.

Importações antigas guardam o retrato da base de cada período. Para eliminar
as anteriores a uma data:

```sql
DELETE FROM importacoes
 WHERE status <> 'confirmada'
   AND criado_em < '2026-01-01'
   AND id <> (SELECT valor FROM configuracoes WHERE chave = 'importacao_ativa');
```

As chaves estrangeiras são `ON DELETE CASCADE`: apagar a importação leva
junto oportunidades, ações, degustações e contratos daquele período.

---

## Direitos do titular (art. 18)

O sistema é **fonte secundária**: o dado nasce no CRM. Um pedido de titular
deve ser atendido primeiro no CRM; aqui é preciso garantir que a cópia
também seja tratada.

### Confirmação e acesso (incisos I e II)

```sql
SELECT o.num, o.contato, o.tipo_evento, o.data_evento, o.status
  FROM oportunidades o
 WHERE lower(o.contato) LIKE lower('%nome do titular%');

SELECT a.nome_cliente, a.acao, a.status_acao, a.dt_agendado, c.nome AS consultor
  FROM acoes a LEFT JOIN consultores c ON c.id = a.consultor_id
 WHERE lower(a.nome_cliente) LIKE lower('%nome do titular%');
```

### Correção (inciso III)

Corrija **no CRM** e reimporte. Corrigir direto no banco daqui é sobrescrito
na importação seguinte.

### Eliminação (inciso VI)

1. Elimine no CRM, para não voltar na próxima importação.
2. Remova a cópia local:

```sql
BEGIN;
DELETE FROM notas WHERE num_oportunidade IN
  (SELECT num FROM oportunidades WHERE lower(contato) = lower('Nome Completo'));
DELETE FROM tratativas WHERE num_oportunidade IN
  (SELECT num FROM oportunidades WHERE lower(contato) = lower('Nome Completo'));
DELETE FROM acoes WHERE lower(nome_cliente) = lower('Nome Completo');
DELETE FROM oportunidades WHERE lower(contato) = lower('Nome Completo');
COMMIT;
```

Confira o resultado antes do `COMMIT`. A auditoria **não** é apagada: o
art. 16, I, autoriza a conservação para cumprimento de obrigação legal, e o
registro de acesso não contém o dado do titular, apenas quem acessou o quê.

### Portabilidade (inciso V)

Use as consultas de acesso e entregue o resultado em CSV. Registre a entrega.

---

## Incidente de segurança (art. 48)

Havendo risco relevante aos titulares, comunique **ANPD e titulares** em prazo
razoável. Passos técnicos em [SEGURANCA.md](SEGURANCA.md#resposta-a-incidente).

Reúna, para a comunicação: natureza dos dados atingidos, titulares envolvidos,
medidas técnicas em uso, riscos e medidas de mitigação adotadas.

A trilha de auditoria é o que permite delimitar o alcance com precisão — sem
ela, qualquer incidente vira "possivelmente tudo".

---

## Operador e controlador

A empresa é a **controladora**. Se este sistema rodar em servidor de terceiro
(nuvem), o provedor é **operador** e o art. 39 exige contrato prevendo o
tratamento. Hospedagem própria evita essa camada.

Os dados **não são compartilhados** com nenhum terceiro pelo sistema: não há
integração de analytics, telemetria, envio de e-mail nem CDN externa. Todo o
CSS e JavaScript é servido pelo próprio domínio — inclusive por isso a CSP usa
`default-src 'self'`. Nenhuma requisição sai para fora.

---

## Checklist antes de entrar em produção

- [ ] Base legal definida e registrada para cada categoria de dado
- [ ] Registro de operações de tratamento atualizado (art. 37)
- [ ] Encarregado (DPO) indicado e comunicado
- [ ] Colaboradores cientes de que o acesso é individual e auditado
- [ ] Prazo de retenção da auditoria conferido com o jurídico
- [ ] Procedimento de resposta a pedido de titular acordado com o CRM
- [ ] Backups criptografados em repouso e com acesso restrito
- [ ] Contrato com o provedor de hospedagem prevendo tratamento (art. 39)
