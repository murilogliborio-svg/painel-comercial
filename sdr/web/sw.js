// Service worker mínimo: só o necessário para o navegador considerar o app
// instalável (PWA). Página, script de lógica e chamadas de API sempre vão
// direto pra rede (nunca cacheados) — painel com dado ao vivo, cache
// agressivo neles geraria tela desatualizada.
//
// Os poucos arquivos cacheados (CSS, ícones) usam "rede primeiro": tenta
// buscar a versão nova sempre que há conexão, e só cai pro cache guardado
// se a rede falhar. Nunca serve uma versão velha por padrão — foi assim
// que um deploy de CSS ficou "preso" numa versão antiga da tela.
const CACHE = 'diterra-sdr-v2';
const ASSETS = ['/assets/app.css', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) => Promise.all(
      chaves.filter((c) => c !== CACHE).map((c) => caches.delete(c)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copia));
        return resposta;
      })
      .catch(() => caches.match(request)),
  );
});
