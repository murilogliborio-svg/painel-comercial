/**
 * Aplicação do painel. JavaScript puro, sem framework e sem build.
 *
 * Duas regras de segurança que valem para todo este arquivo:
 *
 *   1. Nada é inserido no DOM via innerHTML com dado vindo do servidor.
 *      Nome de cliente, observação e nota são conteúdo de terceiro; entram
 *      sempre por textContent. O helper `el()` existe para isso.
 *   2. O que o usuário enxerga NÃO é o que define o que ele pode ver. As
 *      abas escondidas para um consultor são conveniência de interface; a
 *      autorização real está no servidor e é testada lá.
 */

const api = {
  // O token vem do login e é reconfirmado no /api/auth/eu. Os dois nomes de
  // cookie existem porque o prefixo __Host- só vale sob HTTPS (ver config.ts).
  csrf: sessionStorage.getItem('csrf') || lerCookie('__Host-csrf') || lerCookie('csrf') || '',

  async req(metodo, caminho, corpo) {
    const cab = {};
    if (metodo !== 'GET') cab['X-CSRF-Token'] = this.csrf;
    let body;
    if (corpo instanceof Uint8Array || corpo instanceof ArrayBuffer) {
      body = corpo;
      cab['Content-Type'] = 'application/octet-stream';
    } else if (corpo !== undefined) {
      body = JSON.stringify(corpo);
      cab['Content-Type'] = 'application/json';
    }
    const r = await fetch(caminho, { method: metodo, headers: cab, body });
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.mensagem || `Erro ${r.status}`);
      e.detalhe = j.detalhe;
      e.status = r.status;
      throw e;
    }
    return j;
  },
  get(c) { return this.req('GET', c); },
  post(c, b) { return this.req('POST', c, b); },
  patch(c, b) { return this.req('PATCH', c, b); },
  del(c, b) { return this.req('DELETE', c, b); },
};

function lerCookie(nome) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + nome.replace(/[$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// --------------------------------------------------------------- helpers

/** Cria elemento. Texto SEMPRE por textContent — nunca innerHTML. */
function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'texto') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    n.append(typeof f === 'string' || typeof f === 'number' ? document.createTextNode(String(f)) : f);
  }
  return n;
}

const BRL = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const NUM = (n) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const PCT = (n) => `${(Number(n) || 0).toFixed(1).replace('.', ',')}%`;
const ORD = ['1º','2º','3º','4º','5º','6º','7º','8º','9º','10º','11º','12º','13º','14º','15º'];

function dataBR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}
function dataHoraBR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const conteudo = () => document.getElementById('conteudo');
function render(...nos) {
  const c = conteudo();
  c.replaceChildren(...nos.flat().filter(Boolean));
}
function carregando() {
  render(el('div', { class: 'carregando', texto: 'Carregando...' }));
}
function erroNaTela(e) {
  render(
    el('div', { class: 'aviso a-erro' },
      el('h3', { texto: 'Não foi possível carregar' }),
      el('p', { texto: e.message }),
      e.detalhe ? el('p', { texto: JSON.stringify(e.detalhe) }) : null),
  );
}

function kpi(rotulo, valor, nota, classe) {
  return el('div', { class: 'cartao kpi' },
    el('div', { class: 'rot', texto: rotulo }),
    el('div', { class: `val ${classe || ''}`, texto: valor }),
    nota ? el('div', { class: 'nota', texto: nota }) : null);
}

function barras(itens, corDe = () => 'f-s1', fmt = NUM) {
  const max = Math.max(1, ...itens.map((i) => Math.abs(i.valor)));
  return el('div', {},
    itens.map((i) => el('div', { class: 'barra-linha' },
      el('div', { class: 'rot', texto: i.rotulo, title: i.rotulo }),
      el('div', { class: 'trilho' },
        el('div', { class: `preenche ${corDe(i)}`, ...largura(i.valor / max) })),
      el('div', { class: 'val', texto: fmt(i.valor) }))));
}

/**
 * A CSP proíbe atributo style. Larguras variáveis usam custom property via
 * CSSOM (setProperty), aplicada depois da criação do nó.
 */
function largura(frac) {
  return { 'data-frac': String(Math.max(0.004, Math.min(1, frac || 0))) };
}
function aplicarLarguras(raiz) {
  for (const n of raiz.querySelectorAll('[data-frac]')) {
    n.style.width = `${Number(n.dataset.frac) * 100}%`;
  }
  for (const n of raiz.querySelectorAll('[data-left]')) {
    const f = Number(n.dataset.left);
    n.style.left = `${f * 100}%`;
    // Rótulo próximo às bordas encosta em vez de vazar para fora do medidor.
    if (n.tagName === 'SPAN') {
      n.style.transform = f < 0.1 ? 'none' : f > 0.9 ? 'translateX(-100%)' : 'translateX(-50%)';
      if (f < 0.1) { n.style.left = '0'; }
      if (f > 0.9) { n.style.left = '100%'; }
    }
  }
}

function tabela(colunas, linhas) {
  return el('div', { class: 'rolagem' },
    el('table', {},
      el('thead', {}, el('tr', {}, colunas.map((c) => el('th', { texto: c })))),
      el('tbody', {}, linhas)));
}

// ----------------------------------------------------------------- estado

const estado = {
  eu: null,
  base: null,
  aba: null,
  subaba: 'vencidas',
  consultorFoco: null,
};

// ------------------------------------------------------------------- abas

const ABAS = [
  { id: 'meu', rotulo: 'Meu painel', papeis: ['consultor'] },
  { id: 'time', rotulo: 'Visão do time', papeis: ['gestor', 'admin'] },
  { id: 'listas', rotulo: 'Lista de ação', papeis: ['consultor', 'gestor', 'admin'] },
  { id: 'metas', rotulo: 'Metas', papeis: ['consultor', 'gestor', 'admin'] },
  { id: 'importar', rotulo: 'Importar base', papeis: ['gestor', 'admin'] },
  { id: 'equipe', rotulo: 'Usuários', papeis: ['gestor', 'admin'] },
  { id: 'auditoria', rotulo: 'Auditoria', papeis: ['gestor', 'admin'] },
];

function montarAbas() {
  const nav = document.getElementById('abas');
  const visiveis = ABAS.filter((a) => a.papeis.includes(estado.eu.papel));
  nav.replaceChildren(...visiveis.map((a) =>
    el('button', {
      role: 'tab', type: 'button', 'aria-selected': String(a.id === estado.aba),
      texto: a.rotulo, onclick: () => irPara(a.id),
    })));
}

function irPara(aba) {
  estado.aba = aba;
  location.hash = aba;
  montarAbas();
  const fn = VISOES[aba];
  if (fn) fn();
}

// ------------------------------------------------------------ visão: meu

async function visaoMeu() {
  carregando();
  try {
    const [resumo, cons] = await Promise.all([
      api.get('/api/painel/resumo'),
      api.get('/api/painel/consultores'),
    ]);
    const t = resumo.totais;
    const ref = cons.referencia;
    const meu = cons.consultores[0] || {};

    const kpis = el('div', { class: 'grade g-kpi' },
      kpi('Faturamento creditado', BRL(t.faturamento), `${NUM(t.contratos)} contrato(s) no período`,
        t.faturamento > 0 ? '' : 'v-crit'),
      kpi('Oportunidades', NUM(t.oportunidades), `${NUM(t.acoes)} ações registradas`),
      kpi('Pendências vencidas', NUM(t.vencidas), 'ações com data já passada',
        t.vencidas > 0 ? 'v-crit' : 'v-bom'),
      kpi('Degustações', `${NUM(meu.deg_realizadas || 0)}/${NUM(t.degustacoes)}`,
        `realizadas · ${NUM(meu.deg_confirmadas || 0)} confirmadas à frente`),
      kpi('Perdas evitáveis', NUM(meu.perdas_evitaveis || 0), 'preço, concorrente, sem retorno',
        (meu.perdas_evitaveis || 0) > 2 ? 'v-crit' : ''),
    );

    const comp = ref ? el('div', { class: 'cartao' }, ref.metricas.map(comparativo)) : null;

    const nos = [
      el('h2', { class: 'secao', texto: 'Seus números' }),
      kpis,
      ref ? el('h2', { class: 'secao', texto: 'Onde você está em relação ao time' }) : null,
      ref ? el('p', { class: 'lede', texto:
        `A barra é o seu número. O traço escuro é a média dos ${ref.tamanhoTime} consultores; ` +
        'o traço roxo é o melhor do time. Em pendências e perdas, menor é melhor.' }) : null,
      comp,
      el('h2', { class: 'secao', texto: 'Por que você perdeu' }),
      el('div', { class: 'cartao' },
        resumo.motivos.length
          ? barras(resumo.motivos.map((m) => ({ rotulo: rotuloMotivo(m.motivo), valor: m.total, evitavel: m.evitavel })),
              (i) => (i.evitavel ? 'f-crit' : 'f-muted'))
          : el('div', { class: 'vazio', texto: 'Nenhuma oportunidade declarada como perdida no período.' })),
    ];
    render(nos);
    aplicarLarguras(conteudo());
  } catch (e) { erroNaTela(e); }
}

function rotuloMotivo(m) {
  const mapa = {
    'DESQUALIFICADO': 'Desqualificado',
    'CLIENTE/EVENTO SEM PERFIL': 'Cliente/evento sem perfil',
    'CLIENTE PERDIDO - SEM RETORNO DO CLIENTE': 'Perdido — sem retorno',
    'CLIENTE PERDIDO POR PREÇO': 'Perdido por preço',
    'CLIENTE PERDIDO PARA CONCORRENTE': 'Perdido para concorrente',
    'CLIENTE PERDIDO POR DATA': 'Perdido por data',
    'DESISTIU POR MOTIVOS PESSOAIS': 'Desistiu por motivos pessoais',
    'CLIENTE DUPLICADO': 'Cliente duplicado',
  };
  return mapa[m] || m;
}

function comparativo(m) {
  const fmt = m.campo === 'faturamento' ? BRL : NUM;
  const max = Math.max(m.melhor, m.media, m.meu) * 1.06 || 1;
  const acima = m.meu > m.media;
  const bom = m.maiorMelhor ? m.meu >= m.media : m.meu <= m.media;
  const classePos = m.posicao <= 3 ? 'p-topo' : m.posicao >= 9 ? 'p-fim' : 'p-meio';

  return el('div', { class: 'comparativo' },
    el('div', { class: 'cab' },
      el('span', { class: 'mrot', texto: m.rotulo }),
      el('span', { class: 'mval' }, fmt(m.meu),
        el('span', { class: `posicao ${classePos}`, texto: ORD[m.posicao - 1] || `${m.posicao}º` }))),
    el('div', { class: 'marca-linha' },
      el('span', { texto: `média ${fmt(m.media)}`, ...posicaoRotulo(m.media / max) })),
    el('div', { class: 'medidor' },
      el('div', { class: `barra ${bom ? 'f-good' : m.posicao >= 9 ? 'f-crit' : 'f-s4'}`, ...largura(m.meu / max) }),
      el('div', { class: 'tick', ...deslocamento(m.media / max) }),
      el('div', { class: 'tick melhor', ...deslocamento(m.melhor / max) })),
    el('div', { class: 'marca-linha melhor' },
      el('span', { texto: `melhor ${fmt(m.melhor)}${m.melhorNome ? ` (${m.melhorNome.split(' ')[0]})` : ''}`,
        ...posicaoRotulo(m.melhor / max) })),
    el('div', { class: 'rodape' },
      el('span', { texto: `${acima ? '▲ acima' : '▼ abaixo'} da média — ${bom ? 'bom' : 'atenção'}` }),
      el('span', { texto: m.maiorMelhor ? 'quanto maior, melhor' : 'quanto menor, melhor' })));
}

function deslocamento(frac) { return { 'data-left': String(Math.max(0, Math.min(1, frac || 0))) }; }
function posicaoRotulo(frac) {
  return { 'data-left': String(Math.max(0, Math.min(1, frac || 0))) };
}

// ----------------------------------------------------------- visão: time

async function visaoTime() {
  carregando();
  try {
    const [resumo, cons] = await Promise.all([
      api.get('/api/painel/resumo'),
      api.get('/api/painel/consultores'),
    ]);
    const t = resumo.totais;

    const kpis = el('div', { class: 'grade g-kpi' },
      kpi('Faturamento', BRL(t.faturamento), `${NUM(t.contratos)} contratos no período`),
      kpi('Ticket médio', BRL(t.ticket_medio), `desconto médio ${PCT(t.desconto_pct)}`),
      kpi('Oportunidades', NUM(t.oportunidades), `${NUM(t.acoes)} ações`),
      kpi('Pendências vencidas', NUM(t.vencidas), `de ${NUM(t.pendentes)} pendentes`,
        t.vencidas > 0 ? 'v-crit' : 'v-bom'),
      kpi('Degustações', NUM(t.degustacoes), `${NUM(t.deg_canceladas)} canceladas`,
        t.degustacoes && t.deg_canceladas / t.degustacoes > 0.2 ? 'v-alerta' : ''),
      kpi('Abaixo do mínimo', NUM(t.abaixo_minimo), 'contratos sob o piso de preço',
        t.abaixo_minimo > 0 ? 'v-crit' : 'v-bom'),
    );

    const linhas = cons.consultores.map((c) => el('tr', {},
      el('td', { class: 'nome' },
        el('button', { class: 'btn btn-secundario btn-mini', type: 'button', texto: c.nome,
          onclick: () => abrirConsultor(c) })),
      el('td', { texto: NUM(c.opps) }),
      el('td', { texto: NUM(c.acoes) }),
      el('td', { class: c.vencidas >= 28 ? 'v-crit' : '', texto: NUM(c.vencidas) }),
      el('td', { texto: NUM(c.deg_realizadas) }),
      el('td', { class: c.deg_canceladas >= 3 ? 'v-crit' : '', texto: NUM(c.deg_canceladas) }),
      el('td', { class: c.perdas_evitaveis >= 4 ? 'v-crit' : '', texto: NUM(c.perdas_evitaveis) }),
      el('td', { texto: NUM(c.contratos) }),
      el('td', { texto: c.faturamento ? BRL(c.faturamento) : '—' })));

    const soma = cons.consultores.reduce((a, c) => a + c.faturamento, 0);

    render([
      el('h2', { class: 'secao', texto: 'Resultado do período' }),
      kpis,
      el('h2', { class: 'secao', texto: 'Ranking por consultor' }),
      el('p', { class: 'lede', texto:
        'O faturamento de cada um é o crédito dele. Em vendas divididas, cada consultor leva a ' +
        `sua parte — por isso a soma da coluna (${BRL(soma)}) fecha exatamente o faturamento do período.` }),
      el('div', { class: 'cartao rolagem' },
        tabela(['Consultor', 'Opps', 'Ações', 'Vencidas', 'Deg. real.', 'Deg. canc.', 'Perdas evit.', 'Contratos', 'Faturamento'], linhas)),
      el('h2', { class: 'secao', texto: 'Motivos de perda do time' }),
      el('div', { class: 'cartao' },
        barras(resumo.motivos.map((m) => ({ rotulo: rotuloMotivo(m.motivo), valor: m.total, evitavel: m.evitavel })),
          (i) => (i.evitavel ? 'f-crit' : 'f-muted'))),
    ]);
    aplicarLarguras(conteudo());
  } catch (e) { erroNaTela(e); }
}

async function abrirConsultor(c) {
  try {
    const r = await api.get(`/api/painel/consultores?consultor=${encodeURIComponent(c.consultor_id)}`);
    const linha = r.consultores[0] || c;
    abrirModal(linha.nome, [
      el('div', { class: 'grade g-kpi' },
        kpi('Faturamento', BRL(linha.faturamento)),
        kpi('Contratos', NUM(linha.contratos)),
        kpi('Conversão', PCT(linha.opps ? (linha.contratos / linha.opps) * 100 : 0))),
      el('div', { class: 'rolagem' }, tabela(['Indicador', 'Valor'], [
        ['Oportunidades tocadas', NUM(linha.opps)],
        ['Ações registradas', NUM(linha.acoes)],
        ['Concluídas', NUM(linha.concluidas)],
        ['Pendências vencidas', NUM(linha.vencidas)],
        ['Degustações realizadas', NUM(linha.deg_realizadas)],
        ['Degustações canceladas', NUM(linha.deg_canceladas)],
        ['Confirmadas à frente', NUM(linha.deg_confirmadas)],
        ['Perdas declaradas', NUM(linha.perdidos)],
        ['Perdas evitáveis', NUM(linha.perdas_evitaveis)],
      ].map(([k, v]) => el('tr', {}, el('td', { class: 'nome', texto: k }), el('td', { texto: v }))))),
    ]);
  } catch (e) { alertaModal(e.message); }
}

// --------------------------------------------------------- visão: listas

const LISTAS = [
  { id: 'vencidas', rotulo: 'Pendências vencidas' },
  { id: 'degustacoes', rotulo: 'Degustações' },
  { id: 'aguardando', rotulo: 'Aguardando 1º contato' },
  { id: 'sem_sucesso', rotulo: '1º contato sem sucesso' },
  { id: 'perdidos', rotulo: 'Perdidos e motivo' },
  { id: 'contratos', rotulo: 'Contratos' },
];

async function visaoListas() {
  carregando();
  try {
    const r = await api.get(`/api/listas/${estado.subaba}?limite=500`);
    const podeEscrever = estado.eu.pode_escrever;

    const abas = el('div', { class: 'subabas' },
      LISTAS.map((l) => el('button', {
        type: 'button', 'aria-selected': String(l.id === estado.subaba), texto: l.rotulo,
        onclick: () => { estado.subaba = l.id; visaoListas(); },
      })));

    let corpo;
    if (!r.itens.length) {
      corpo = el('div', { class: 'vazio', texto: mensagemVazio(estado.subaba) });
    } else if (estado.subaba === 'contratos') {
      corpo = tabela(['Contrato', 'Descrição', 'Casa', 'Evento', 'Situação', 'Valor'],
        r.itens.map((i) => el('tr', {},
          el('td', { class: 'nome', texto: i.referencia && i.referencia.startsWith('CT') ? i.referencia : '—' }),
          el('td', { texto: i.cliente || '—' }),
          el('td', { texto: i.detalhe || '—' }),
          el('td', { texto: dataBR(i.data_evento) }),
          el('td', {}, el('span', { class: 'selo s-neutro', texto: i.marcador || '—' })),
          el('td', { texto: BRL(i.referencia) }))));
    } else if (estado.subaba === 'degustacoes') {
      corpo = tabela(['Oportunidade', 'Quando', 'Casa', 'Status', 'Nº'],
        r.itens.map((i) => el('tr', {},
          el('td', { class: 'nome', texto: i.cliente || '—' }),
          el('td', { texto: dataHoraBR(i.data_evento) }),
          el('td', { texto: i.detalhe || '—' }),
          el('td', {}, el('span', {
            class: `selo ${i.marcador === 'REALIZADO' ? 's-ok' : i.marcador === 'CANCELADO' ? 's-crit' : 's-alerta'}`,
            texto: i.marcador || '—' })),
          el('td', { texto: i.num_oportunidade || '—' }))));
    } else {
      corpo = tabela(
        ['Cliente', 'Oportunidade', estado.subaba === 'perdidos' ? 'Motivo' : 'Detalhe',
         'Evento', 'Dias', 'Notas', 'Ação'],
        r.itens.map((i) => el('tr', {},
          el('td', { class: 'nome', texto: i.cliente || '—' }),
          el('td', { texto: i.num_oportunidade || '—' }),
          el('td', { texto: estado.subaba === 'perdidos' ? rotuloMotivo(i.detalhe) : (i.detalhe || '—') }),
          el('td', { texto: dataBR(i.data_evento) }),
          el('td', { class: i.dias > 7 ? 'v-crit' : '', texto: i.dias === null ? '—' : `${i.dias} d` }),
          el('td', {},
            el('button', { class: 'btn btn-secundario btn-mini', type: 'button',
              texto: i.notas ? `${i.notas} nota(s)` : 'ver',
              onclick: () => abrirNotas(i) })),
          el('td', {},
            i.tratada
              ? el('span', { class: 'selo s-ok', texto: 'TRATADA' })
              : podeEscrever
                ? el('button', { class: 'btn btn-mini', type: 'button', texto: 'Dar baixa',
                    onclick: () => abrirTratativa(i) })
                : el('span', { class: 'selo s-neutro', texto: '—' })))));
    }

    render([
      el('h2', { class: 'secao', texto: 'Lista de ação' }),
      el('p', { class: 'lede', texto: estado.eu.papel === 'consultor'
        ? 'Clientes da sua carteira que exigem providência. Dê baixa conforme for tratando.'
        : 'Visão do time inteiro. Clique em "Dar baixa" para registrar tratativa em nome de um consultor.' }),
      abas,
      el('div', { class: 'cartao' }, corpo),
      el('p', { class: 'lede', texto: `${r.itens.length} registro(s). Teto de 500 por consulta.` }),
    ]);
  } catch (e) { erroNaTela(e); }
}

function mensagemVazio(tipo) {
  const m = {
    vencidas: 'Nenhuma pendência vencida. Agenda em dia.',
    degustacoes: 'Nenhuma degustação no período.',
    aguardando: 'Nenhum lead aguardando primeiro contato.',
    sem_sucesso: 'Nenhum registro de "1º contato sem sucesso".',
    perdidos: 'Nenhuma oportunidade declarada como perdida.',
    contratos: 'Nenhum contrato no período.',
  };
  return m[tipo] || 'Nada por aqui.';
}

function abrirTratativa(item) {
  const sel = el('select', { id: 'res' },
    el('option', { value: 'contato_feito', texto: 'Contato feito' }),
    el('option', { value: 'reagendado', texto: 'Reagendado' }),
    el('option', { value: 'sem_resposta', texto: 'Sem resposta' }),
    el('option', { value: 'concluido', texto: 'Concluído' }),
    el('option', { value: 'nao_se_aplica', texto: 'Não se aplica' }));
  const obs = el('textarea', { id: 'obs', placeholder: 'O que aconteceu? (opcional)' });
  const consultorCampo = estado.eu.papel === 'consultor' ? null
    : el('div', {}, el('label', { for: 'cid', texto: 'Consultor responsável (id)' }),
        el('input', { type: 'text', id: 'cid', placeholder: 'cole o id do consultor' }));

  abrirModal(`Dar baixa — ${item.cliente || item.num_oportunidade}`, [
    el('p', { class: 'lede', texto: `Oportunidade ${item.num_oportunidade || '—'}` }),
    el('label', { for: 'res', texto: 'Resultado' }), sel,
    consultorCampo,
    el('label', { for: 'obs', texto: 'Observação' }), obs,
  ], async () => {
    const corpo = {
      num_oportunidade: item.num_oportunidade,
      chave_acao: item.chave,
      resultado: sel.value,
      observacao: obs.value || undefined,
    };
    if (consultorCampo) corpo.consultor_id = document.getElementById('cid').value.trim();
    await api.post('/api/trabalho/tratativa', corpo);
    fecharModal();
    visaoListas();
  });
}

async function abrirNotas(item) {
  if (!item.num_oportunidade) { alertaModal('Este registro não tem oportunidade vinculada.'); return; }
  try {
    const r = await api.get(`/api/trabalho/notas/${encodeURIComponent(item.num_oportunidade)}`);
    const campo = el('textarea', { id: 'nova-nota', placeholder: 'Escreva uma nota sobre esta negociação...' });
    const lista = el('div', {},
      r.notas.length
        ? r.notas.map((n) => el('div', { class: 'nota-item' },
            el('div', { texto: n.texto }),
            el('div', { class: 'meta', texto: `${n.autor} · ${dataHoraBR(n.criado_em)}` })))
        : el('div', { class: 'vazio', texto: 'Nenhuma nota ainda.' }));

    abrirModal(`Notas — ${item.cliente || item.num_oportunidade}`, [
      lista,
      estado.eu.pode_escrever ? el('label', { for: 'nova-nota', texto: 'Nova nota' }) : null,
      estado.eu.pode_escrever ? campo : null,
    ], estado.eu.pode_escrever ? async () => {
      const texto = campo.value.trim();
      if (!texto) { fecharModal(); return; }
      const corpo = { num_oportunidade: item.num_oportunidade, texto };
      if (estado.eu.papel !== 'consultor') corpo.consultor_id = estado.consultorFoco || '';
      await api.post('/api/trabalho/notas', corpo);
      fecharModal();
      visaoListas();
    } : null);
  } catch (e) { alertaModal(e.message); }
}

// ---------------------------------------------------------- visão: metas

async function visaoMetas() {
  carregando();
  try {
    const [r, cons] = await Promise.all([
      api.get('/api/metas'),
      estado.eu.papel === 'consultor' ? Promise.resolve({ consultores: [] }) : api.get('/api/admin/consultores'),
    ]);
    const gestor = estado.eu.papel !== 'consultor';

    const linhas = r.metas.map((m) => el('tr', {},
      el('td', { class: 'nome', texto: m.consultor }),
      el('td', { texto: m.metrica }),
      el('td', { texto: m.metrica === 'faturamento' ? BRL(m.alvo) : NUM(m.alvo) }),
      el('td', { texto: `${dataBR(m.periodo_ini)} a ${dataBR(m.periodo_fim)}` }),
      el('td', { texto: m.observacao || '—' }),
      gestor ? el('td', {}, el('button', {
        class: 'btn btn-secundario btn-mini', type: 'button', texto: 'Remover',
        onclick: async () => { await api.del(`/api/metas/${m.id}`); visaoMetas(); },
      })) : null));

    const form = gestor ? formMetas(cons.consultores) : null;

    render([
      el('h2', { class: 'secao', texto: 'Metas' }),
      el('p', { class: 'lede', texto: gestor
        ? 'Defina metas individuais por período. O consultor enxerga apenas as dele.'
        : 'Metas definidas pelo gestor para o seu período.' }),
      form,
      el('div', { class: 'cartao' },
        r.metas.length
          ? tabela(['Consultor', 'Métrica', 'Alvo', 'Período', 'Observação', gestor ? '' : null].filter((x) => x !== null), linhas)
          : el('div', { class: 'vazio', texto: 'Nenhuma meta definida.' })),
    ]);
  } catch (e) { erroNaTela(e); }
}

function formMetas(consultores) {
  const sc = el('select', { id: 'm-cons' },
    consultores.filter((c) => c.ativo).map((c) => el('option', { value: c.id, texto: c.nome })));
  const sm = el('select', { id: 'm-metrica' },
    ['faturamento', 'contratos', 'degustacoes', 'conversao', 'acoes']
      .map((m) => el('option', { value: m, texto: m })));
  const alvo = el('input', { type: 'number', id: 'm-alvo', min: '0', step: 'any' });
  const ini = el('input', { type: 'date', id: 'm-ini' });
  const fim = el('input', { type: 'date', id: 'm-fim' });
  const msg = el('div', { class: 'escondido' });

  return el('div', { class: 'cartao' },
    el('div', { class: 'linha-form' },
      el('div', { class: 'campo' }, el('label', { for: 'm-cons', texto: 'Consultor' }), sc),
      el('div', { class: 'campo' }, el('label', { for: 'm-metrica', texto: 'Métrica' }), sm),
      el('div', { class: 'campo' }, el('label', { for: 'm-alvo', texto: 'Alvo' }), alvo),
      el('div', { class: 'campo' }, el('label', { for: 'm-ini', texto: 'De' }), ini),
      el('div', { class: 'campo' }, el('label', { for: 'm-fim', texto: 'Até' }), fim),
      el('button', { class: 'btn', type: 'button', texto: 'Salvar meta', onclick: async () => {
        try {
          await api.post('/api/metas', {
            consultor_id: sc.value, metrica: sm.value, alvo: Number(alvo.value),
            periodo_ini: ini.value, periodo_fim: fim.value,
          });
          visaoMetas();
        } catch (e) {
          msg.className = 'erro-caixa';
          msg.textContent = e.message;
        }
      } })),
    msg);
}

// ------------------------------------------------------- visão: importar

async function visaoImportar() {
  carregando();
  try {
    const r = await api.get('/api/importacao');
    const enviados = [];

    const zona = el('div', { class: 'solta', id: 'zona' },
      el('strong', { texto: 'Clique aqui ou arraste as 4 planilhas do CRM' }),
      el('span', { texto: 'Oportunidades · Listagem de Ações · Degustações Comercial · Extrato de Vendas' }));
    const input = el('input', { type: 'file', id: 'arqs', multiple: true, accept: '.xlsx', class: 'escondido' });
    const listaArq = el('ul', { class: 'arquivos' });
    const msg = el('div', { class: 'escondido' });
    const botao = el('button', { class: 'btn', type: 'button', texto: 'Analisar arquivos', disabled: 'disabled' });

    async function enviar(arquivos) {
      msg.className = 'escondido';
      for (const f of arquivos) {
        if (!/\.xlsx$/i.test(f.name)) continue;
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          const r2 = await fetch('/api/importacao/arquivo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': api.csrf, 'X-Arquivo-Nome': f.name },
            body: buf,
          });
          const j = await r2.json().catch(() => ({}));
          if (!r2.ok) throw new Error(j.mensagem || 'falha no envio');
          enviados.push({ nome: f.name, bytes: f.size });
        } catch (e) {
          msg.className = 'erro-caixa';
          msg.textContent = `${f.name}: ${e.message}`;
        }
      }
      listaArq.replaceChildren(...enviados.map((a) => el('li', {},
        el('span', { class: 'selo s-ok', texto: 'OK' }),
        el('span', { texto: a.nome }),
        el('span', { class: 'tam', texto: `${(a.bytes / 1024).toFixed(0)} KB` }))));
      botao.disabled = enviados.length < 4;
      botao.textContent = enviados.length < 4
        ? `Analisar arquivos (${enviados.length}/4)` : 'Analisar arquivos';
    }

    zona.addEventListener('click', () => input.click());
    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('ativa'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('ativa'));
    zona.addEventListener('drop', (e) => {
      e.preventDefault(); zona.classList.remove('ativa');
      enviar([...e.dataTransfer.files]);
    });
    input.addEventListener('change', () => enviar([...input.files]));
    botao.addEventListener('click', async () => {
      botao.disabled = true; botao.textContent = 'Analisando...';
      try {
        const prev = await api.post('/api/importacao/preparar', {});
        mostrarPrevia(prev);
      } catch (e) {
        msg.className = 'erro-caixa';
        msg.replaceChildren(
          el('div', { texto: e.message }),
          e.detalhe ? el('pre', { texto: JSON.stringify(e.detalhe, null, 1) }) : null);
        botao.disabled = false; botao.textContent = 'Analisar arquivos';
      }
    });

    const historico = r.importacoes.map((i) => el('tr', {},
      el('td', { class: 'nome', texto: `${dataHoraBR(i.criado_em)}` }),
      el('td', { texto: i.autor }),
      el('td', {}, el('span', {
        class: `selo ${i.id === r.ativa ? 's-ok' : i.status === 'rascunho' ? 's-alerta' : 's-neutro'}`,
        texto: i.id === r.ativa ? 'ATIVA' : i.status.toUpperCase() })),
      el('td', { texto: `${dataBR(i.periodo_ini)} a ${dataBR(i.periodo_fim)}` }),
      el('td', { texto: NUM(i.estatisticas.oportunidades) }),
      el('td', { texto: NUM(i.estatisticas.totalContratos) }),
      el('td', { texto: BRL(i.estatisticas.faturamentoCentavos / 100) }),
      el('td', {},
        i.status === 'rascunho'
          ? el('span', {},
              el('button', { class: 'btn btn-mini', type: 'button', texto: 'Confirmar',
                onclick: async () => { await api.post(`/api/importacao/${i.id}/confirmar`); visaoImportar(); } }),
              el('button', { class: 'btn btn-secundario btn-mini', type: 'button', texto: 'Descartar',
                onclick: async () => { await api.del(`/api/importacao/${i.id}`); visaoImportar(); } }))
          : i.id === r.ativa
            ? el('button', { class: 'btn btn-secundario btn-mini', type: 'button', texto: 'Reverter',
                onclick: async () => {
                  if (!confirm('Reverter para a importação anterior?')) return;
                  await api.post(`/api/importacao/${i.id}/reverter`); visaoImportar();
                } })
            : el('span', { class: 'selo s-neutro', texto: '—' }))));

    render([
      el('h2', { class: 'secao', texto: 'Importar base do CRM' }),
      el('p', { class: 'lede', texto:
        'Envie os quatro relatórios do mesmo período. O sistema valida, mostra o que vai mudar ' +
        'e só substitui a base ativa depois da sua confirmação.' }),
      el('div', { class: 'cartao' }, zona, input, listaArq, msg,
        el('div', { class: 'linha-form' }, botao)),
      el('h2', { class: 'secao', texto: 'Histórico de importações' }),
      el('div', { class: 'cartao' },
        r.importacoes.length
          ? tabela(['Quando', 'Quem', 'Status', 'Período', 'Opps', 'Contratos', 'Faturamento', ''], historico)
          : el('div', { class: 'vazio', texto: 'Nenhuma importação ainda.' })),
    ]);
  } catch (e) { erroNaTela(e); }
}

function mostrarPrevia(p) {
  const s = p.estatisticas;
  const alertas = p.comparacao?.alertas ?? [];

  abrirModal('Confira antes de publicar', [
    el('div', { class: 'grade g-kpi' },
      kpi('Oportunidades', NUM(s.oportunidades)),
      kpi('Ações', NUM(s.acoes)),
      kpi('Degustações', NUM(s.degustacoes)),
      kpi('Contratos', NUM(s.totalContratos)),
      kpi('Faturamento', BRL(s.faturamentoCentavos / 100))),
    el('p', { class: 'lede', texto: `Período detectado: ${dataBR(s.periodoIni)} a ${dataBR(s.periodoFim)}.` }),
    p.novosConsultores.length
      ? el('div', { class: 'aviso a-alerta' },
          el('h3', { texto: 'Consultores novos nesta base' }),
          el('p', { texto: p.novosConsultores.join(', ') }))
      : null,
    ...alertas.map((a) => el('div', { class: 'aviso a-erro' },
      el('h3', { texto: 'Variação suspeita' }), el('p', { texto: a }))),
    el('p', { class: 'lede', texto:
      'Ao publicar, esta base passa a ser a que todo mundo enxerga. A anterior fica guardada e ' +
      'pode ser restaurada a qualquer momento.' }),
  ], async () => {
    await api.post(`/api/importacao/${p.importId}/confirmar`);
    fecharModal();
    visaoImportar();
  }, 'Publicar base');
}

// -------------------------------------------------------- visão: equipe

async function visaoEquipe() {
  carregando();
  try {
    const [u, c] = await Promise.all([api.get('/api/admin/usuarios'), api.get('/api/admin/consultores')]);
    const admin = estado.eu.papel === 'admin';

    const usuarios = u.usuarios.map((x) => el('tr', {},
      el('td', { class: 'nome', texto: x.nome }),
      el('td', { texto: x.email }),
      el('td', {}, el('span', { class: 'selo s-neutro', texto: x.papel })),
      el('td', { texto: x.consultor || '—' }),
      el('td', {}, el('span', {
        class: `selo ${x.ativo ? 's-ok' : 's-crit'}`, texto: x.ativo ? 'ativo' : 'inativo' })),
      el('td', { texto: x.pode_escrever ? 'edita' : 'leitura' }),
      el('td', { texto: dataHoraBR(x.ultimo_login) }),
      el('td', {}, admin ? el('span', {},
        el('button', { class: 'btn btn-secundario btn-mini', type: 'button', texto: 'Nova senha',
          onclick: async () => {
            if (!confirm(`Gerar nova senha para ${x.email}? As sessões dele serão encerradas.`)) return;
            const r = await api.patch(`/api/admin/usuarios/${x.id}`, { redefinir_senha: true });
            alertaModal(`Senha provisória de ${x.email}:\n\n${r.senhaProvisoria}\n\nEntregue pessoalmente. Não será exibida de novo.`);
          } }),
        el('button', { class: 'btn btn-secundario btn-mini', type: 'button', texto: x.ativo ? 'Desativar' : 'Ativar',
          onclick: async () => { await api.patch(`/api/admin/usuarios/${x.id}`, { ativo: !x.ativo }); visaoEquipe(); } }),
      ) : el('span', { class: 'selo s-neutro', texto: '—' }))));

    const consultores = c.consultores.map((x) => el('tr', {},
      el('td', { class: 'nome', texto: x.nome }),
      el('td', { texto: x.email || 'sem usuário' }),
      el('td', {}, el('span', { class: `selo ${x.ativo ? 's-ok' : 's-neutro'}`, texto: x.ativo ? 'ativo' : 'oculto' })),
      el('td', { class: 'nome', texto: x.id }),
      el('td', {}, el('button', {
        class: 'btn btn-secundario btn-mini', type: 'button', texto: x.ativo ? 'Ocultar do painel' : 'Reativar',
        onclick: async () => {
          try {
            await api.patch(`/api/admin/consultores/${x.id}`, { ativo: !x.ativo });
            visaoEquipe();
          } catch (e) { alertaModal(e.message); }
        } }))));

    render([
      el('h2', { class: 'secao', texto: 'Usuários' }),
      el('p', { class: 'lede', texto: admin
        ? 'Criar usuário gera uma senha provisória exibida uma única vez. Entregue pessoalmente.'
        : 'Somente o administrador cria ou altera usuários.' }),
      admin ? formUsuario(c.consultores) : null,
      el('div', { class: 'cartao' },
        tabela(['Nome', 'E-mail', 'Perfil', 'Consultor', 'Situação', 'Permissão', 'Último acesso', ''], usuarios)),
      el('h2', { class: 'secao', texto: 'Consultores da base' }),
      el('p', { class: 'lede', texto:
        'Nomes que aparecem nas planilhas do CRM. Oculte os que não são pessoas (equipes genéricas) ' +
        'ou que saíram — eles somem das médias e do ranking, mas o histórico é preservado.' }),
      el('div', { class: 'cartao' },
        tabela(['Consultor', 'Usuário vinculado', 'Situação', 'Id', ''], consultores)),
    ]);
  } catch (e) { erroNaTela(e); }
}

function formUsuario(consultores) {
  const nome = el('input', { type: 'text', id: 'u-nome' });
  const email = el('input', { type: 'email', id: 'u-email', autocapitalize: 'none' });
  const papel = el('select', { id: 'u-papel' },
    el('option', { value: 'consultor', texto: 'consultor' }),
    el('option', { value: 'gestor', texto: 'gestor' }),
    el('option', { value: 'admin', texto: 'admin' }));
  const cons = el('select', { id: 'u-cons' },
    el('option', { value: '', texto: '— sem vínculo —' }),
    consultores.filter((c) => c.ativo && !c.email).map((c) => el('option', { value: c.id, texto: c.nome })));
  const escreve = el('select', { id: 'u-escreve' },
    el('option', { value: '1', texto: 'pode editar' }),
    el('option', { value: '0', texto: 'somente leitura' }));
  const msg = el('div', { class: 'escondido' });

  return el('div', { class: 'cartao' },
    el('div', { class: 'linha-form' },
      el('div', { class: 'campo' }, el('label', { for: 'u-nome', texto: 'Nome' }), nome),
      el('div', { class: 'campo' }, el('label', { for: 'u-email', texto: 'E-mail' }), email),
      el('div', { class: 'campo' }, el('label', { for: 'u-papel', texto: 'Perfil' }), papel),
      el('div', { class: 'campo' }, el('label', { for: 'u-cons', texto: 'Consultor' }), cons),
      el('div', { class: 'campo' }, el('label', { for: 'u-escreve', texto: 'Permissão' }), escreve),
      el('button', { class: 'btn', type: 'button', texto: 'Criar usuário', onclick: async () => {
        try {
          const r = await api.post('/api/admin/usuarios', {
            nome: nome.value.trim(), email: email.value.trim(), papel: papel.value,
            consultor_id: cons.value || undefined, pode_escrever: escreve.value === '1',
          });
          msg.className = 'ok-caixa';
          msg.textContent = `Usuário criado. Senha provisória de ${r.email}: ${r.senhaProvisoria} — anote agora, não será exibida de novo.`;
          nome.value = ''; email.value = '';
        } catch (e) {
          msg.className = 'erro-caixa';
          msg.textContent = e.message;
        }
      } })),
    msg);
}
// ----------------------------------------------------- visão: auditoria

async function visaoAuditoria() {
  carregando();
  try {
    const r = await api.get('/api/admin/auditoria?limite=300');
    const linhas = r.registros.map((x) => el('tr', {},
      el('td', { class: 'nome', texto: dataHoraBR(x.criado_em) }),
      el('td', { texto: x.email || '—' }),
      el('td', { texto: x.acao }),
      el('td', { texto: x.entidade ? `${x.entidade}${x.entidade_id ? ` ${x.entidade_id}` : ''}` : '—' }),
      el('td', {}, el('span', { class: `selo ${x.sucesso ? 's-ok' : 's-crit'}`, texto: x.sucesso ? 'ok' : 'falha' })),
      el('td', { texto: x.ip || '—' })));

    render([
      el('h2', { class: 'secao', texto: 'Trilha de auditoria' }),
      el('p', { class: 'lede', texto:
        'Registro de acessos e operações. Guardado para atender ao art. 37 da LGPD e para ' +
        'investigação de incidente. Últimos 300 eventos.' }),
      el('div', { class: 'cartao' },
        tabela(['Quando', 'Quem', 'Ação', 'Alvo', 'Resultado', 'IP'], linhas)),
    ]);
  } catch (e) { erroNaTela(e); }
}

const VISOES = {
  meu: visaoMeu, time: visaoTime, listas: visaoListas, metas: visaoMetas,
  importar: visaoImportar, equipe: visaoEquipe, auditoria: visaoAuditoria,
};

// ------------------------------------------------------------------ modal

function abrirModal(titulo, corpo, aoConfirmar, rotuloConfirmar = 'Salvar') {
  const host = document.getElementById('modal');
  const fundo = el('div', { class: 'modal-fundo', onclick: (e) => { if (e.target === fundo) fecharModal(); } },
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('h3', { texto: titulo }),
      el('div', {}, corpo),
      el('div', { class: 'acoes' },
        el('button', { class: 'btn btn-secundario', type: 'button', texto: aoConfirmar ? 'Cancelar' : 'Fechar',
          onclick: fecharModal }),
        aoConfirmar ? el('button', { class: 'btn', type: 'button', texto: rotuloConfirmar,
          onclick: async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            try { await aoConfirmar(); } catch (e) { alertaModal(e.message); } finally { b.disabled = false; }
          } }) : null)));
  host.replaceChildren(fundo);
  aplicarLarguras(fundo);
  document.addEventListener('keydown', escFecha);
}
function escFecha(e) { if (e.key === 'Escape') fecharModal(); }
function fecharModal() {
  document.getElementById('modal').replaceChildren();
  document.removeEventListener('keydown', escFecha);
}
function alertaModal(msg) {
  abrirModal('Aviso', [el('p', { class: 'lede', texto: msg })]);
}

function abrirTrocaSenha() {
  const atual = el('input', { type: 'password', id: 's-atual', autocomplete: 'current-password' });
  const nova = el('input', { type: 'password', id: 's-nova', autocomplete: 'new-password' });
  const msg = el('div', { class: 'escondido' });
  abrirModal('Trocar senha', [
    el('label', { for: 's-atual', texto: 'Senha atual' }), atual,
    el('label', { for: 's-nova', texto: 'Nova senha (mínimo 12 caracteres)' }), nova,
    el('p', { class: 'lede', texto: 'Uma frase com quatro palavras é mais forte e mais fácil de lembrar que "S3nh@!".' }),
    msg,
  ], async () => {
    try {
      const r = await api.post('/api/auth/senha', { atual: atual.value, nova: nova.value });
      fecharModal();
      alertaModal(`Senha alterada. ${r.sessoesEncerradas} outra(s) sessão(ões) foram encerradas.`);
    } catch (e) {
      msg.className = 'erro-caixa';
      msg.textContent = e.message;
    }
  }, 'Trocar senha');
}

// ------------------------------------------------------------------ boot

document.getElementById('btn-sair').addEventListener('click', async () => {
  try { await api.post('/api/auth/logout'); } catch { /* segue para o login */ }
  sessionStorage.removeItem('csrf');
  location.href = '/login';
});
document.getElementById('btn-senha').addEventListener('click', abrirTrocaSenha);
document.getElementById('btn-tema').addEventListener('click', () => {
  const atual = document.documentElement.getAttribute('data-tema');
  const escuroSO = matchMedia('(prefers-color-scheme: dark)').matches;
  const novo = atual ? (atual === 'escuro' ? 'claro' : 'escuro') : (escuroSO ? 'claro' : 'escuro');
  document.documentElement.setAttribute('data-tema', novo);
  localStorage.setItem('tema', novo);
});
const temaSalvo = localStorage.getItem('tema');
if (temaSalvo) document.documentElement.setAttribute('data-tema', temaSalvo);

(async function iniciar() {
  try {
    const r = await api.get('/api/auth/eu');
    estado.eu = r.usuario;
    estado.base = r.base;
    // Recupera o token do cookie a cada carga: sessionStorage não sobrevive
    // a uma aba nova, mas o cookie sim.
    api.csrf = lerCookie('__Host-csrf') || lerCookie('csrf') || api.csrf;

    document.getElementById('quem-nome').textContent = r.usuario.nome;
    document.getElementById('quem-papel').textContent =
      r.usuario.papel + (r.usuario.pode_escrever ? '' : ' · somente leitura');

    if (r.base) {
      document.getElementById('periodo-base').textContent =
        `${dataBR(r.base.periodo_ini)} a ${dataBR(r.base.periodo_fim)}`;
    }
    document.getElementById('rodape').textContent =
      'Acesso individual e auditado. As listas contêm dados pessoais de clientes — não compartilhe ' +
      'capturas de tela nem exporte para fora dos sistemas da empresa.';

    if (r.usuario.trocar_senha) {
      abrirTrocaSenha();
    }

    const inicial = location.hash.slice(1);
    const permitidas = ABAS.filter((a) => a.papeis.includes(estado.eu.papel)).map((a) => a.id);
    irPara(permitidas.includes(inicial) ? inicial : permitidas[0]);
  } catch {
    location.href = '/login';
  }
})();
