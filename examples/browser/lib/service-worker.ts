/**
 * Service Worker — intercepts fetch events for app URLs and bridges them
 * to the POSIX kernel via MessageChannel HTTP bridge.
 *
 * Includes a cookie jar because Set-Cookie headers on synthetic SW
 * responses are ignored by the browser.  The SW stores cookies from
 * bridge responses and attaches them to outgoing requests.
 */
import { bridgeFetch, initBridgePort, isBridgeReady } from "./http-bridge";

let appPrefix = "/app/";

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

// --- Cookie jar ---

interface Cookie {
  name: string;
  value: string;
  path: string;
  expires?: number; // ms since epoch
}

const cookieJar = new Map<string, Cookie>();

function parseSetCookie(header: string): Cookie | null {
  const parts = header.split(";").map((s) => s.trim());
  if (parts.length === 0) return null;

  const eqIdx = parts[0].indexOf("=");
  if (eqIdx < 0) return null;

  const name = parts[0].slice(0, eqIdx);
  const value = parts[0].slice(eqIdx + 1);
  let path = "/";
  let expires: number | undefined;

  for (let i = 1; i < parts.length; i++) {
    const lower = parts[i].toLowerCase();
    if (lower.startsWith("path=")) {
      path = parts[i].slice(5);
    } else if (lower.startsWith("expires=")) {
      const d = new Date(parts[i].slice(8));
      if (!isNaN(d.getTime())) expires = d.getTime();
    } else if (lower.startsWith("max-age=")) {
      const seconds = parseInt(parts[i].slice(8));
      if (!isNaN(seconds)) expires = Date.now() + seconds * 1000;
    }
  }

  return { name, value, path, expires };
}

function storeCookies(setCookieValues: string[]): void {
  for (const raw of setCookieValues) {
    const cookie = parseSetCookie(raw);
    if (!cookie) continue;
    if (cookie.expires !== undefined && cookie.expires < Date.now()) {
      cookieJar.delete(cookie.name);
    } else {
      cookieJar.set(cookie.name, cookie);
    }
  }
}

function getCookiesForPath(path: string): string {
  const pairs: string[] = [];
  for (const [name, cookie] of cookieJar) {
    if (cookie.expires !== undefined && cookie.expires < Date.now()) {
      cookieJar.delete(name);
      continue;
    }
    if (path.startsWith(cookie.path)) {
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
  }
  return pairs.join("; ");
}

// --- Lifecycle ---

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

// --- Configuration via postMessage ---

sw.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "init-bridge") {
    const port = event.ports[0];
    if (port) {
      initBridgePort(port);
      appPrefix = msg.appPrefix ?? "/app/";
    }
    const replyPort = event.ports[1];
    if (replyPort) {
      replyPort.postMessage({ type: "bridge-ready" });
    }
  }
});

// --- Fetch interception ---

sw.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(appPrefix)) return;
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
    headers["host"] = url.host;

    // Inject cookies from our jar (browser won't send them because
    // Set-Cookie on SW responses is ignored)
    const jarCookies = getCookiesForPath(url.pathname);
    if (jarCookies) {
      const existing = headers["cookie"];
      headers["cookie"] = existing ? existing + "; " + jarCookies : jarCookies;
    }

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

    // --- Store cookies from bridge response ---
    const rawSetCookie =
      bridgeResp.headers["Set-Cookie"] || bridgeResp.headers["set-cookie"];
    if (rawSetCookie) {
      // Multiple Set-Cookie values are joined by \n in connection-pump
      storeCookies(rawSetCookie.split("\n"));
    }

    // --- Build Response ---
    const respHeaders = new Headers();
    for (const [key, value] of Object.entries(bridgeResp.headers)) {
      const lower = key.toLowerCase();
      if (
        lower === "transfer-encoding" ||
        lower === "connection" ||
        lower === "keep-alive"
      ) {
        continue;
      }
      if (lower === "set-cookie") {
        for (const cookie of value.split("\n")) {
          respHeaders.append(key, cookie);
        }
      } else {
        respHeaders.set(key, value);
      }
    }

    // Rewrite redirect Location: if it doesn't already include the
    // app prefix, prepend it so the browser stays in SW scope
    if (bridgeResp.status >= 300 && bridgeResp.status < 400) {
      const location =
        bridgeResp.headers["Location"] || bridgeResp.headers["location"];
      if (location) {
        try {
          const locUrl = new URL(location, url.origin);
          if (
            locUrl.origin === url.origin &&
            !locUrl.pathname.startsWith(appPrefix)
          ) {
            locUrl.pathname = appPrefix.slice(0, -1) + locUrl.pathname;
            respHeaders.set("Location", locUrl.toString());
          }
        } catch {
          /* leave as-is */
        }
      }
    }

    // COEP/CORP for cross-origin isolation (SharedArrayBuffer)
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
