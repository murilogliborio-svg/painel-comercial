/* Tela de login. Sem dependências, sem script inline (a CSP proíbe). */
const temaSalvo = localStorage.getItem('sdr-tema');
if (temaSalvo === 'claro' || temaSalvo === 'escuro') {
  document.documentElement.setAttribute('data-tema', temaSalvo);
}

const form = document.getElementById('form-login');
const caixaErro = document.getElementById('erro');
const botao = document.getElementById('entrar');

function mostrarErro(msg) {
  caixaErro.textContent = msg;
  caixaErro.classList.remove('escondido');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  caixaErro.classList.add('escondido');

  const email = document.getElementById('email').value.trim();
  const senha = document.getElementById('senha').value;
  if (!email || !senha) { mostrarErro('Preencha e-mail e senha.'); return; }

  botao.disabled = true;
  botao.textContent = 'Entrando...';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      mostrarErro(j.mensagem || 'Não foi possível entrar.');
      return;
    }
    location.href = '/painel';
  } catch {
    mostrarErro('Falha de conexão com o servidor. Tente novamente.');
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});

function esconderBoasVindas() {
  const el = document.getElementById('tela-boas-vindas');
  if (!el) return;
  el.classList.add('saindo');
  setTimeout(() => el.remove(), 500);
}

const verificacaoSessao = fetch('/api/auth/eu')
  .then((r) => { if (r.ok) location.href = '/painel'; return r.ok; })
  .catch(() => false);
const esperaMinima = new Promise((resolve) => setTimeout(resolve, 900));
Promise.all([verificacaoSessao, esperaMinima]).then(([logado]) => {
  if (!logado) esconderBoasVindas();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
