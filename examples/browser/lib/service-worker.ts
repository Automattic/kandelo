/**
 * Service Worker — intercepts fetch events for app URLs and bridges them
 * to the POSIX kernel via SharedArrayBuffer HTTP bridge.
 */
import {
  bridgeFetch,
  STATUS_IDLE,
  type HttpRequest,
} from "./http-bridge";

// The shared buffer and configuration are received via postMessage from the main thread.
let bridgeBuffer: SharedArrayBuffer | null = null;
let numSlots = 4;
let appPrefix = "/app/";
let nextSlot = 0;
// Track which slots are currently in use
const slotInUse = new Set<number>();

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
    bridgeBuffer = msg.buffer as SharedArrayBuffer;
    numSlots = msg.numSlots ?? 4;
    appPrefix = msg.appPrefix ?? "/app/";
    slotInUse.clear();
  }
});

// --- Fetch interception ---

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Only intercept requests matching the app prefix
  if (!url.pathname.startsWith(appPrefix)) return;

  // If bridge not initialized, fall through
  if (!bridgeBuffer) return;

  event.respondWith(handleAppRequest(event.request, url));
});

async function handleAppRequest(
  request: Request,
  url: URL,
): Promise<Response> {
  if (!bridgeBuffer) {
    return new Response("Service worker bridge not initialized", { status: 503 });
  }

  // Find a free slot
  const slot = acquireSlot();
  if (slot < 0) {
    return new Response("All bridge slots busy", { status: 503 });
  }

  try {
    // Build the HTTP request that nginx/PHP will see
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

    const bridgeReq: HttpRequest = {
      method: request.method,
      url: appPath + url.search,
      headers,
      body,
    };

    const bridgeResp = await bridgeFetch(bridgeBuffer, slot, bridgeReq);

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

    return new Response(bridgeResp.body, {
      status: bridgeResp.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(`Bridge error: ${err}`, { status: 502 });
  } finally {
    releaseSlot(slot);
  }
}

function acquireSlot(): number {
  // Find a slot that isn't in use
  for (let i = 0; i < numSlots; i++) {
    const slot = (nextSlot + i) % numSlots;
    if (!slotInUse.has(slot)) {
      const header = new Int32Array(bridgeBuffer!, slot * (256 * 1024), 1);
      if (Atomics.load(header, 0) === STATUS_IDLE) {
        slotInUse.add(slot);
        nextSlot = (slot + 1) % numSlots;
        return slot;
      }
    }
  }
  return -1;
}

function releaseSlot(slot: number): void {
  slotInUse.delete(slot);
}
