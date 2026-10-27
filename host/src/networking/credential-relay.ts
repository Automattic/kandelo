/** Explicit guest credentials, never ambient browser authentication. */
export interface CredentialRelayConfig {
  readonly url: string;
  readonly allowedOrigins: readonly string[];
}

export const CREDENTIAL_RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function validateCredentialRelayConfig(value: CredentialRelayConfig): CredentialRelayConfig {
  if (!value || typeof value.url !== 'string' || !Array.isArray(value.allowedOrigins)) {
    throw new TypeError('Invalid credential relay configuration');
  }
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError('Credential relay must be a local HTTP(S) endpoint');
  }
  for (const origin of value.allowedOrigins) {
    const target = new URL(origin);
    if (target.protocol !== 'https:' || target.origin !== origin) {
      throw new TypeError('Credential relay destinations must be exact HTTPS origins');
    }
  }
  return Object.freeze({ url: url.href, allowedOrigins: Object.freeze([...value.allowedOrigins]) });
}

/**
 * Self-contained so the classic service worker can use the same transport.
 * Check permission before even sending a guest credential to the relay.
 */
export function createCredentialRelayTransport() {
  type Config = { url: string; allowedOrigins: readonly string[] };
  type Send = (url: string, init: RequestInit) => Promise<Response>;
  const maxBody = 8 * 1024 * 1024;
  function endpoint(config: Config): URL {
    const url = new URL(config.url, globalThis.location?.origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol) || url.username ||
        url.password || url.search || url.hash) {
      throw new Error('Credential relay must be a local HTTP(S) endpoint');
    }
    if (globalThis.location && url.origin !== globalThis.location.origin) {
      throw new Error('Credential relay must have the same origin as Kandelo');
    }
    return url;
  }
  return async function credentialRelayFetch(
    config: Config,
    request: {
      targetUrl: string;
      method: string;
      headers: readonly (readonly [string, string])[];
      body?: BodyInit | null;
      signal?: AbortSignal;
    },
    send: Send = (url, init) => globalThis.fetch(url, init),
  ): Promise<Response> {
    const target = new URL(request.targetUrl);
    if (target.protocol !== 'https:' || target.username || target.password ||
        !config.allowedOrigins.includes(target.origin)) {
      throw new Error('Credential relay destination is not permitted');
    }
    const base = endpoint(config).href.replace(/\/$/, '');
    const status = await send(`${base}/status`, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: request.signal,
    });
    if (!status.ok) throw new Error('Credential relay permission could not be checked');
    const permission = await status.json();
    if (permission?.approved !== true ||
        !Array.isArray(permission.allowedOrigins) ||
        !permission.allowedOrigins.includes(target.origin)) {
      throw new Error(`Credential relay requires your permission at ${base}`);
    }
    request.signal?.throwIfAborted();
    // Only materialize a body after consent. Bound streams as well as buffers.
    let body: string | null = null;
    if (request.body !== undefined && request.body !== null) {
      const reader = new Response(request.body).body!.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maxBody) throw new Error('Credential relay request body exceeds 8 MiB');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const pieces: string[] = [];
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i += 8192) {
          pieces.push(String.fromCharCode(...chunk.subarray(i, i + 8192)));
        }
      }
      body = btoa(pieces.join(''));
    }
    // The envelope keeps guest headers distinct from the browser's cookies,
    // Origin and Authorization on the outer, same-origin request.
    return send(`${base}/request`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer', signal: request.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, targetUrl: target.href,
        method: request.method, headers: request.headers, body }),
    });
  };
}

export const fetchWithCredentialRelay = createCredentialRelayTransport();
