self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (!new URL(event.request.url).pathname.endsWith('/network.json')) return;
  event.respondWith((async () => new Response(JSON.stringify({
    source: 'worker', method: event.request.method, keepalive: event.request.keepalive,
    body: await event.request.text(),
  }), { headers: { 'Content-Type': 'application/json' } }))());
});
