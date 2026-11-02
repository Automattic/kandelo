// Answers every request for probe.txt itself; the network copy says
// "from-network". Records the beacons it sees and reports them at
// beacon-seen.txt. Contains no Kandelo code.
const beacons = new Set();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/probe.txt")) {
    event.respondWith(new Response("from-service-worker"));
  } else if (url.pathname.endsWith("/beacon.txt")) {
    beacons.add(url.searchParams.get("id"));
    event.respondWith(new Response("from-service-worker"));
  } else if (url.pathname.endsWith("/beacon-seen.txt")) {
    event.respondWith(new Response(beacons.has(url.searchParams.get("id")) ? "seen" : "unseen"));
  }
});
