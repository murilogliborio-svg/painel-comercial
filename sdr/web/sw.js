// Service worker mínimo: só o necessário para o navegador considerar o app
// instalável (PWA). Cache limitado a assets realmente estáticos — página,
// script de lógica e chamadas de API sempre vão direto pra rede, porque
// este é um painel com dado ao vivo (leads, mensagens); cache agressivo
// aqui geraria tela desatualizada, o que é pior que sem cache nenhum.
const CACHE = 'diterra-sdr-v1';
const ASSETS = ['/assets/app.css', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
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
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
