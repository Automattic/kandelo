/**
 * Browser transport for the proxy's quota-only session protocol. This factory
 * is self-contained: Vite also embeds it in the classic service worker.
 * Spacefast cookies stay on their own origin. Cross-site proxies use a signed
 * quota token, persisted on the application's origin, even without cookies.
 */
export interface ProxySessionStorage {
  read(origin: string): Promise<unknown>;
  write(origin: string, value: unknown): Promise<void>;
}

export function createProxySessionTransport(storage?: ProxySessionStorage | null) {
  type Session = { token: string; expiresAt: number };
  type Send = (url: string, init: RequestInit) => Promise<Response>;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Promise<Session>>();
  const header = "X-Kandelo-Proxy-Session";
  function valid(value: unknown): value is Session {
    const s = value as Session | null;
    return !!s && typeof s.token === "string" && /^v1\.[a-f0-9]{32}\.[0-9]{10}\.[a-f0-9]{64}$/.test(s.token)
      && typeof s.expiresAt === "number" && s.expiresAt > Date.now() / 1000;
  }
  // IndexedDB is available in all three browser realms and preserves the
  // credential across reloads without depending on HTTP-cache lifetimes.
  function storageOperation(origin: string, value?: Session): Promise<unknown> {
    if (storage !== undefined) return value
      ? storage?.write(origin, value) ?? Promise.resolve()
      : storage?.read(origin) ?? Promise.resolve(undefined);
    if (!globalThis.indexedDB) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let finished = false;
      const open = indexedDB.open("kandelo-proxy-sessions-v1", 1);
      const timeout = setTimeout(() => { finished = true; reject(new Error("Proxy session storage timed out")); }, 2000);
      const fail = () => { finished = true; clearTimeout(timeout); reject(new Error("Proxy session storage unavailable")); };
      open.onerror = fail;
      open.onblocked = fail;
      open.onupgradeneeded = () => open.result.createObjectStore("sessions");
      open.onsuccess = () => {
        const db = open.result;
        if (finished) { db.close(); return; }
        try {
          const tx = db.transaction("sessions", value ? "readwrite" : "readonly");
          const store = tx.objectStore("sessions");
          const request = value ? store.put(value, origin) : store.get(origin);
          tx.oncomplete = () => { finished = true; clearTimeout(timeout); db.close(); resolve(request.result); };
          tx.onabort = tx.onerror = () => { db.close(); fail(); };
        } catch { db.close(); fail(); }
      };
    });
  }
  async function read(origin: string) {
    const memory = sessions.get(origin);
    if (valid(memory)) return memory;
    try {
      const value = await storageOperation(origin);
      if (valid(value)) { sessions.set(origin, value); return value; }
    } catch { /* Blocked storage is equivalent to no persisted token. */ }
    return undefined;
  }
  async function session(origin: string, previous: string | undefined, send: Send): Promise<Session> {
    const existing = pending.get(origin);
    if (existing) return existing;
    async function issue() {
      const stored = await read(origin);
      if (stored && stored.token !== previous) return stored;
      const response = await send(`${origin}/cors-proxy-session`, {
        method: "GET", credentials: globalThis.location?.origin === origin ? "same-origin" : "omit",
        referrerPolicy: "strict-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`CORS proxy session failed (${response.status})`);
      const value: unknown = await response.json();
      if (!valid(value)) throw new Error("CORS proxy returned an invalid session");
      sessions.set(origin, value);
      try { await storageOperation(origin, value); }
      catch { /* Keep the in-memory session when persistence is unavailable. */ }
      return value;
    }
    // Serialize first use across page, kernel worker and service worker too.
    const locks = globalThis.navigator?.locks;
    const promise = locks ? locks.request(`kandelo-proxy-session:${origin}`, issue) : issue();
    pending.set(origin, promise);
    try { return await promise; } finally { pending.delete(origin); }
  }
  return async function proxyFetch(url: string, init: RequestInit, send: Send): Promise<Response> {
    const origin = new URL(url).origin;
    const stored = await read(origin);
    const headers = new Headers(init.headers);
    // This is transport metadata, never a guest-controlled HTTP header.
    headers.delete(header);
    if (stored) headers.set(header, stored.token);
    const projected = { ...init, headers, referrerPolicy: "strict-origin" as const };
    const response = await send(url, projected);
    if (response.status !== 401 || response.headers.get(header) !== "required") return response;
    await response.body?.cancel().catch(() => {});
    // Browser networking sends replayable strings/byte arrays here. Do not
    // silently retry a caller's consumed stream or duplicate an upstream POST.
    if (init.body instanceof ReadableStream) throw new Error("CORS proxy session requires a replayable request body");
    const fresh = await session(origin, stored?.token, send);
    init.signal?.throwIfAborted();
    headers.set(header, fresh.token);
    return send(url, projected); // One retry; the 401 spent no upstream request.
  };
}

export const fetchWithProxySession = createProxySessionTransport();
