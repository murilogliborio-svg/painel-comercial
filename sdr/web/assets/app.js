/* Painel do SDR de I.A. — sem framework, sem script inline (CSP proíbe). */

function csrf() {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?sdr-csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(caminho, opts = {}) {
  const metodo = opts.method || 'GET';
  const headers = { 'Content-Type': 'application/json' };
  if (metodo !== 'GET') headers['X-CSRF-Token'] = csrf();
  const r = await fetch(caminho, {
    method: metodo,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.mensagem || 'Erro na requisição.');
  return j;
}

function avisar(msg, tipo = 'a-ok') {
  const el = document.getElementById('aviso-global');
  el.className = `aviso ${tipo}`;
  el.textContent = msg;
  el.classList.remove('escondido');
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => el.classList.add('escondido'), 6000);
}

function fmtData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Estilo WhatsApp: hora se for hoje, "Ontem" se foi ontem, dd/mm senão. */
function fmtDataLista(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoje = new Date();
  const diasAtras = Math.floor((hoje.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diasAtras === 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (diasAtras === 1) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function iniciais(nome) {
  const partes = (nome || '?').trim().split(/\s+/);
  const a = partes[0]?.[0] || '?';
  const b = partes.length > 1 ? partes[partes.length - 1][0] : '';
  return (a + b).toUpperCase();
}

/** Cor determinística por nome — mesmo lead sempre com a mesma cor, sem inline style (CSP proíbe). */
function classeAvatar(nome) {
  let h = 0;
  for (const c of nome || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `avatar-c${h % 8}`;
}

function iconeTique(status) {
  if (status === 'entregue' || status === 'lida') {
    return `<svg class="tique${status === 'lida' ? ' tique-lida' : ''}" viewBox="0 0 18 12" width="18" height="12" aria-hidden="true">`
      + `<path d="M1 6l3.5 3.5L11 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="M6 6l3.5 3.5L17 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  return `<svg class="tique" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">`
    + `<path d="M1 6l3.5 3.5L11 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Janela de atendimento de 24h — mesma regra do backend (regras.ts janelaDeServicoAtiva). */
function janelaAberta(ultimaRespostaEm) {
  if (!ultimaRespostaEm) return false;
  const desde = Date.now() - Date.parse(ultimaRespostaEm);
  return desde >= 0 && desde < 24 * 3_600_000;
}

const ROTULO_ESTAGIO = {
  novo: 'Novo', aquecendo: 'Aquecendo', aguardando_resposta: 'Aguardando resposta',
  respondeu: 'Respondeu', quente: 'Quente', convertido: 'Convertido',
  perdido: 'Perdido', pausado: 'Pausado',
};

// ---------------------------------------------------------------- sessão --

let EU = null;

async function iniciar() {
  try {
    const j = await api('/api/auth/eu');
    EU = j.usuario;
  } catch {
    location.href = '/login';
    return;
  }
  document.getElementById('quem-nome').textContent = EU.nome;
  document.getElementById('quem-papel').textContent = EU.papel;
  if (EU.papel === 'admin') {
    for (const id of ['aba-config', 'aba-usuarios', 'aba-auditoria']) {
      document.getElementById(id).hidden = false;
    }
  }
  configurarAbas();
  configurarLeads();
  configurarConfig();
  configurarUsuarios();
  configurarAuditoria();
  await carregarLeads();
}

document.getElementById('btn-sair').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// ------------------------------------------------------------------ abas --

function configurarAbas() {
  const secoes = {
    leads: document.getElementById('painel-leads'),
    config: document.getElementById('painel-config'),
    usuarios: document.getElementById('painel-usuarios'),
    auditoria: document.getElementById('painel-auditoria'),
  };
  document.getElementById('abas').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-aba]');
    if (!btn) return;
    for (const b of document.querySelectorAll('#abas button')) b.setAttribute('aria-selected', String(b === btn));
    for (const [nome, el] of Object.entries(secoes)) el.hidden = nome !== btn.dataset.aba;
    if (btn.dataset.aba === 'config') await carregarConfig();
    if (btn.dataset.aba === 'usuarios') await carregarUsuarios();
    if (btn.dataset.aba === 'auditoria') await carregarAuditoria();
  });
}

// ----------------------------------------------------------------- leads --

let LEAD_ATUAL = null;

function configurarLeads() {
  document.getElementById('filtro-busca').addEventListener('input', debounce(carregarLeads, 300));
  document.getElementById('filtro-estagio').addEventListener('change', carregarLeads);

  document.getElementById('btn-novo-lead').addEventListener('click', () => {
    document.getElementById('form-lead').reset();
    document.getElementById('modal-fundo').classList.remove('escondido');
  });
  document.getElementById('btn-cancelar-lead').addEventListener('click', () => {
    document.getElementById('modal-fundo').classList.add('escondido');
  });
  document.getElementById('form-lead').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const j = await api('/api/leads', {
        method: 'POST',
        body: {
          nome: val('l-nome'), telefone: val('l-telefone'), email: val('l-email'),
          origem: val('l-origem'), contexto: val('l-contexto'),
        },
      });
      document.getElementById('modal-fundo').classList.add('escondido');
      await carregarLeads();
      selecionarLead(j.lead.id);
    } catch (e) {
      avisar(e.message, 'a-erro');
    }
  });

  document.getElementById('btn-salvar-lead').addEventListener('click', async () => {
    if (!LEAD_ATUAL) return;
    try {
      await api(`/api/leads/${LEAD_ATUAL.id}`, {
        method: 'PATCH',
        body: { estagio: val('lead-estagio'), contexto: val('lead-contexto') },
      });
      avisar('Lead salvo.');
      await carregarLeads();
      await abrirLead(LEAD_ATUAL.id);
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('btn-toggle-automacao').addEventListener('click', async () => {
    if (!LEAD_ATUAL) return;
    try {
      await api(`/api/leads/${LEAD_ATUAL.id}`, {
        method: 'PATCH', body: { automacao_ativa: !LEAD_ATUAL.automacao_ativa },
      });
      await carregarLeads();
      await abrirLead(LEAD_ATUAL.id);
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('btn-excluir-lead').addEventListener('click', async () => {
    if (!LEAD_ATUAL) return;
    const confirma = confirm(
      `Excluir "${LEAD_ATUAL.nome}" e toda a conversa com ele? Essa ação não pode ser desfeita.`,
    );
    if (!confirma) return;
    try {
      await api(`/api/leads/${LEAD_ATUAL.id}`, { method: 'DELETE' });
      LEAD_ATUAL = null;
      document.getElementById('painel-lead').classList.add('escondido');
      document.getElementById('painel-lead-vazio').classList.remove('escondido');
      avisar('Lead excluído.');
      await carregarLeads();
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('btn-importar-leads').addEventListener('click', () => {
    document.getElementById('imp-arquivo').value = '';
    document.getElementById('imp-resultado').classList.add('escondido');
    document.getElementById('modal-importar-fundo').classList.remove('escondido');
  });
  document.getElementById('btn-cancelar-importar').addEventListener('click', () => {
    document.getElementById('modal-importar-fundo').classList.add('escondido');
  });
  document.getElementById('btn-confirmar-importar').addEventListener('click', async () => {
    const arquivo = document.getElementById('imp-arquivo').files[0];
    if (!arquivo) { avisar('Escolha um arquivo CSV primeiro.', 'a-erro'); return; }
    const resultadoEl = document.getElementById('imp-resultado');
    try {
      const csv = await arquivo.text();
      const j = await api('/api/leads/importar', { method: 'POST', body: { csv } });
      resultadoEl.classList.remove('escondido');
      resultadoEl.innerHTML = '';
      const p1 = document.createElement('p');
      p1.textContent = `${j.criados} lead(s) criado(s). ${j.duplicados} já existia(m) (pulado(s), não sobrescrito(s)).`;
      resultadoEl.appendChild(p1);
      if (j.erros.length > 0) {
        const p2 = document.createElement('p');
        const primeiros = j.erros.slice(0, 5).map((e) => `linha ${e.linha} (${e.motivo})`).join(', ');
        p2.textContent = `${j.erros.length} linha(s) com problema: ${primeiros}${j.erros.length > 5 ? '…' : ''}`;
        resultadoEl.appendChild(p2);
      }
      await carregarLeads();
    } catch (e) {
      avisar(e.message, 'a-erro');
    }
  });

  document.getElementById('form-conversa').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!LEAD_ATUAL) return;
    const texto = val('conversa-texto');
    if (!texto.trim()) return;
    try {
      await api(`/api/leads/${LEAD_ATUAL.id}/mensagens`, { method: 'POST', body: { texto } });
      document.getElementById('conversa-texto').value = '';
      await carregarLeads();
      await abrirLead(LEAD_ATUAL.id);
    } catch (e) { avisar(e.message, 'a-erro'); }
  });
}

async function carregarLeads() {
  const busca = val('filtro-busca');
  const estagio = val('filtro-estagio');
  const q = new URLSearchParams();
  if (busca) q.set('busca', busca);
  if (estagio) q.set('estagio', estagio);
  const j = await api(`/api/leads?${q.toString()}`);
  renderLista(j.leads);
}

function renderLista(leads) {
  const el = document.getElementById('lista-leads');
  if (leads.length === 0) { el.innerHTML = '<div class="vazio">Nenhum lead encontrado.</div>'; return; }
  el.innerHTML = '';
  for (const lead of leads) {
    const precisaAtencao = lead.estagio === 'respondeu';
    const btn = document.createElement('button');
    btn.className = `item-lead${precisaAtencao ? ' precisa-atencao' : ''}`;
    btn.setAttribute('aria-selected', String(LEAD_ATUAL && LEAD_ATUAL.id === lead.id));
    btn.innerHTML = `
      <span class="avatar ${classeAvatar(lead.nome)}"></span>
      <span class="item-lead-corpo">
        <span class="item-lead-topo">
          <span class="nome"></span>
          <span class="quando"></span>
        </span>
        <span class="item-lead-baixo">
          <span class="preview"></span>
          ${precisaAtencao ? '<span class="ponto-atencao" title="Precisa de atenção"></span>' : ''}
        </span>
      </span>`;
    btn.querySelector('.avatar').textContent = iniciais(lead.nome);
    btn.querySelector('.nome').textContent = lead.nome;
    btn.querySelector('.quando').textContent = fmtDataLista(lead.ultima_mensagem_em);
    const prefixo = lead.ultima_mensagem_direcao === 'saida' ? 'Você: ' : '';
    btn.querySelector('.preview').textContent = lead.ultima_mensagem_texto
      ? prefixo + lead.ultima_mensagem_texto
      : (ROTULO_ESTAGIO[lead.estagio] || lead.estagio);
    btn.addEventListener('click', () => selecionarLead(lead.id));
    el.appendChild(btn);
  }
}

function selecionarLead(id) {
  for (const b of document.querySelectorAll('.item-lead')) {
    b.setAttribute('aria-selected', 'false');
  }
  abrirLead(id);
}

async function abrirLead(id) {
  const j = await api(`/api/leads/${id}`);
  LEAD_ATUAL = j.lead;
  document.getElementById('painel-lead-vazio').classList.add('escondido');
  document.getElementById('painel-lead').classList.remove('escondido');

  const avatar = document.getElementById('lead-avatar');
  avatar.textContent = iniciais(LEAD_ATUAL.nome);
  avatar.className = `avatar avatar-lg ${classeAvatar(LEAD_ATUAL.nome)}`;
  document.getElementById('lead-nome').textContent = LEAD_ATUAL.nome;
  document.getElementById('lead-telefone').textContent = LEAD_ATUAL.telefone;
  document.getElementById('lead-estagio-selo').textContent = ROTULO_ESTAGIO[LEAD_ATUAL.estagio] || LEAD_ATUAL.estagio;
  document.getElementById('lead-estagio').value = LEAD_ATUAL.estagio;
  document.getElementById('lead-contexto').value = LEAD_ATUAL.contexto || '';
  document.getElementById('lead-origem').textContent = LEAD_ATUAL.origem || '—';
  document.getElementById('lead-passo').textContent = String(LEAD_ATUAL.sequencia_passo);
  document.getElementById('lead-automacao').textContent = LEAD_ATUAL.opt_out
    ? 'desligada (opt-out do lead)'
    : LEAD_ATUAL.automacao_ativa ? 'ativa' : 'pausada';
  const btnAuto = document.getElementById('btn-toggle-automacao');
  btnAuto.textContent = LEAD_ATUAL.automacao_ativa ? 'Pausar automação' : 'Retomar automação';
  btnAuto.disabled = !!LEAD_ATUAL.opt_out;

  document.getElementById('aviso-janela').classList.toggle('escondido', janelaAberta(LEAD_ATUAL.ultima_resposta_em));

  const msgs = document.getElementById('conversa-msgs');
  msgs.innerHTML = '';
  for (const m of j.mensagens) {
    const div = document.createElement('div');
    div.className = `bolha ${m.direcao === 'saida' ? 'bolha-saida' : 'bolha-entrada'}`;
    const selo = m.gerada_por_ia ? '<span class="selo-ia">Gerada por I.A.</span>' : '';
    div.innerHTML = `${selo}<span class="texto"></span><span class="quando"></span>`;
    div.querySelector('.texto').textContent = m.texto;

    const quando = div.querySelector('.quando');
    if (m.status === 'simulada') {
      quando.append(`${fmtData(m.criado_em)} · simulada`);
    } else if (m.status === 'falhou') {
      quando.append(`${fmtData(m.criado_em)} · falhou${m.erro ? ': ' + m.erro : ''}`);
    } else {
      quando.append(fmtData(m.criado_em));
      if (m.direcao === 'saida') {
        quando.insertAdjacentHTML('beforeend', iconeTique(m.entrega_status || 'enviada'));
      }
    }
    msgs.appendChild(div);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// --------------------------------------------------------------- config --

function linhaPasso(passo, idx) {
  const div = document.createElement('div');
  div.className = 'passo-item';
  div.dataset.idx = String(idx);
  div.innerHTML = `
    <div class="cab">
      <span>Passo ${idx + 1}</span>
      <button type="button" class="btn btn-secundario btn-mini btn-remover-passo">Remover</button>
    </div>
    <div class="linha-form">
      <div class="campo"><label>Dias de espera</label><input type="number" min="0" class="p-dias"></div>
      <div class="campo campo-flex3"><label>Objetivo (rótulo interno)</label><input type="text" class="p-objetivo"></div>
    </div>
    <div class="linha-form">
      <div class="campo campo-flex3"><label>Nome do modelo aprovado na Meta</label>
        <input type="text" class="p-template" placeholder="ex.: abertura_evento"></div>
    </div>`;
  div.querySelector('.p-dias').value = passo.diasDeEspera;
  div.querySelector('.p-objetivo').value = passo.objetivo;
  div.querySelector('.p-template').value = passo.nomeTemplate || '';
  div.querySelector('.btn-remover-passo').addEventListener('click', () => div.remove());
  return div;
}

function configurarConfig() {
  document.getElementById('form-persona').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/config/persona', {
        method: 'PUT',
        body: {
          nomeEmpresa: val('p-empresa'), nomeAtendente: val('p-atendente'),
          tom: val('p-tom'), diretrizes: val('p-diretrizes'),
        },
      });
      avisar('Persona salva.');
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('form-regras').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const passos = [...document.querySelectorAll('.passo-item')].map((div) => ({
      diasDeEspera: Number(div.querySelector('.p-dias').value) || 0,
      objetivo: div.querySelector('.p-objetivo').value.trim(),
      nomeTemplate: div.querySelector('.p-template').value.trim(),
    }));
    try {
      await api('/api/config/regras', {
        method: 'PUT',
        body: {
          horarioInicio: Number(val('r-hi')), horarioFim: Number(val('r-hf')),
          limiteMsgsPorDia: Number(val('r-teto')), intervaloMinHoras: Number(val('r-intervalo')),
          maxSequenciaSemResposta: Number(val('r-semresposta')),
          palavrasOptOut: val('r-optout').split(',').map((s) => s.trim()).filter(Boolean),
          idiomaTemplates: val('r-idioma-template') || 'pt_BR',
          passos,
        },
      });
      avisar('Regras salvas.');
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('btn-varredura').addEventListener('click', async () => {
    try {
      const j = await api('/api/varredura', { method: 'POST' });
      const enviados = j.resultados.filter((r) => r.enviado).length;
      avisar(`Varredura concluída: ${j.resultados.length} lead(s) avaliado(s), ${enviados} mensagem(ns) enviada(s).`);
    } catch (e) { avisar(e.message, 'a-erro'); }
  });

  document.getElementById('form-qualificacao').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/config/qualificacao', {
        method: 'PUT',
        body: {
          ativa: document.getElementById('q-ativa').checked,
          maxMensagens: Number(val('q-max')),
          objetivo: val('q-objetivo'),
        },
      });
      avisar('Qualificação salva.');
    } catch (e) { avisar(e.message, 'a-erro'); }
  });
}

async function carregarConfig() {
  const [{ persona }, { regras }, { qualificacao }] = await Promise.all([
    api('/api/config/persona'), api('/api/config/regras'), api('/api/config/qualificacao'),
  ]);
  document.getElementById('q-ativa').checked = qualificacao.ativa;
  document.getElementById('q-max').value = qualificacao.maxMensagens;
  document.getElementById('q-objetivo').value = qualificacao.objetivo;
  document.getElementById('p-empresa').value = persona.nomeEmpresa;
  document.getElementById('p-atendente').value = persona.nomeAtendente;
  document.getElementById('p-tom').value = persona.tom;
  document.getElementById('p-diretrizes').value = persona.diretrizes;

  document.getElementById('r-hi').value = regras.horarioInicio;
  document.getElementById('r-hf').value = regras.horarioFim;
  document.getElementById('r-teto').value = regras.limiteMsgsPorDia;
  document.getElementById('r-intervalo').value = regras.intervaloMinHoras;
  document.getElementById('r-semresposta').value = regras.maxSequenciaSemResposta;
  document.getElementById('r-optout').value = regras.palavrasOptOut.join(', ');
  document.getElementById('r-idioma-template').value = regras.idiomaTemplates || 'pt_BR';

  const wrap = document.getElementById('passos-config');
  wrap.innerHTML = '';
  regras.passos.forEach((p, i) => wrap.appendChild(linhaPasso(p, i)));
  const btnAdd = document.createElement('button');
  btnAdd.type = 'button';
  btnAdd.className = 'btn btn-secundario btn-mini';
  btnAdd.textContent = '+ Adicionar passo';
  btnAdd.addEventListener('click', () => {
    wrap.insertBefore(linhaPasso({ diasDeEspera: 3, objetivo: '', nomeTemplate: '' }, wrap.children.length), btnAdd);
  });
  wrap.appendChild(btnAdd);
}

// -------------------------------------------------------------- usuários --

function configurarUsuarios() {
  document.getElementById('form-usuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const j = await api('/api/admin/usuarios', {
        method: 'POST',
        body: { nome: val('u-nome'), email: val('u-email'), papel: val('u-papel') },
      });
      avisar(`Usuário criado. Senha provisória: ${j.senhaProvisoria} (anote agora, não aparece de novo).`);
      document.getElementById('form-usuario').reset();
      await carregarUsuarios();
    } catch (e) { avisar(e.message, 'a-erro'); }
  });
}

async function carregarUsuarios() {
  const j = await api('/api/admin/usuarios');
  const corpo = document.querySelector('#tabela-usuarios tbody');
  corpo.innerHTML = '';
  for (const u of j.usuarios) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="nome"></td><td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = u.nome;
    tr.children[1].textContent = u.email;
    tr.children[2].textContent = u.papel;
    tr.children[3].textContent = u.ativo ? 'sim' : 'não';
    tr.children[4].textContent = fmtData(u.ultimo_login);
    corpo.appendChild(tr);
  }
}

// ------------------------------------------------------------- auditoria --

function configurarAuditoria() {}

async function carregarAuditoria() {
  const j = await api('/api/admin/auditoria?limite=200');
  const corpo = document.querySelector('#tabela-auditoria tbody');
  corpo.innerHTML = '';
  for (const reg of j.registros) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="nome"></td><td></td><td></td><td></td><td></td><td class="detalhe-auditoria"></td>';
    tr.children[0].textContent = fmtData(reg.criado_em);
    tr.children[1].textContent = reg.email || '—';
    tr.children[2].textContent = reg.acao;
    tr.children[3].textContent = [reg.entidade, reg.entidade_id].filter(Boolean).join(' · ');
    tr.children[4].textContent = reg.sucesso ? 'sim' : 'não';
    tr.children[5].textContent = reg.detalhe || '—';
    if (reg.detalhe) tr.children[5].title = reg.detalhe;
    corpo.appendChild(tr);
  }
}

// -------------------------------------------------------------- helpers --

function val(id) { return document.getElementById(id).value.trim(); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

iniciar();
