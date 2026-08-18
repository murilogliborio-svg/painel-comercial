# Planilhas de amostra

Os testes que dependem de dados reais procuram quatro arquivos **neste
diretório**:

```
oportunidades.xlsx    relatório "Oportunidades"
acoes.xlsx            relatório "Listagem de Ações"
degustacoes.xlsx      relatório "Degustações Comercial"
vendas.xlsx           extrato de vendas do mês
```

Eles **não são versionados** (ver `.gitignore`) porque contêm nome de cliente
final — dado pessoal de terceiro. Colocá-los num repositório Git significaria
espalhar esse dado por todas as cópias do projeto, para sempre, o que
contraria o que está escrito no `LGPD.md`.

Para rodar a suíte completa, exporte os quatro relatórios do CRM e salve-os
aqui com esses nomes. Ou aponte para outro diretório:

```bash
AMOSTRAS_XLSX=/caminho/para/planilhas npm test
```

Sem os arquivos, os testes que dependem deles são **pulados** (`skipped`) e os
demais continuam rodando normalmente — a suíte nunca fica vermelha por causa
disso.
