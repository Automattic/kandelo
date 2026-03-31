/**
 * Service Worker — intercepts fetch events for app URLs and bridges them
 * to the POSIX kernel via MessageChannel HTTP bridge.
 */
import { bridgeFetch, initBridgePort, isBridgeReady } from "./http-bridge";

let appPrefix = "/app/";

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

// --- Lifecycle ---

sw.addEventListener("install", () => {
  // Activate immediately, don't wait for other tabs
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  // Claim all clients immediately
  event.waitUntil(sw.clients.claim());
});

// --- Configuration via postMessage ---

sw.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "init-bridge") {
    // Receive the MessagePort for communicating with the main thread
    const port = event.ports[0];
    if (port) {
      initBridgePort(port);
      appPrefix = msg.appPrefix ?? "/app/";
    }
    // Confirm bridge initialization to the caller
    const replyPort = event.ports[1];
    if (replyPort) {
      replyPort.postMessage({ type: "bridge-ready" });
    }
  }
});

// --- Fetch interception ---

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Only intercept requests matching the app prefix
  if (!url.pathname.startsWith(appPrefix)) return;

  // If bridge not initialized, fall through
  if (!isBridgeReady()) return;

  event.respondWith(handleAppRequest(event.request, url));
});

async function handleAppRequest(
  request: Request,
  url: URL,
): Promise<Response> {
  if (!isBridgeReady()) {
    return new Response("Service worker bridge not initialized", {
      status: 503,
    });
  }

  try {
    // Strip the app prefix so nginx sees the original path
    const appPath = url.pathname.slice(appPrefix.length - 1); // Keep leading /

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Set Host header to what the server expects
    headers["host"] = url.host;

    let body: Uint8Array | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const ab = await request.arrayBuffer();
      if (ab.byteLength > 0) {
        body = new Uint8Array(ab);
      }
    }

    const bridgeResp = await bridgeFetch({
      method: request.method,
      url: appPath + url.search,
      headers,
      body,
    });

    // Build Response object
    const respHeaders = new Headers();
    for (const [key, value] of Object.entries(bridgeResp.headers)) {
      // Skip headers that browsers don't allow setting
      const lower = key.toLowerCase();
      if (
        lower === "transfer-encoding" ||
        lower === "connection" ||
        lower === "keep-alive"
      ) {
        continue;
      }
      respHeaders.set(key, value);
    }

    // Ensure COEP/CORP headers so content can load in cross-origin isolated context
    if (!respHeaders.has("Cross-Origin-Embedder-Policy")) {
      respHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (!respHeaders.has("Cross-Origin-Resource-Policy")) {
      respHeaders.set("Cross-Origin-Resource-Policy", "same-origin");
    }

    return new Response(bridgeResp.body, {
      status: bridgeResp.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(`Bridge error: ${err}`, { status: 502 });
  }
}
