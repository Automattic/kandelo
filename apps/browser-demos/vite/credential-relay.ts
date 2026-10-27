import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const COOKIE = 'kandelo-local-credential-relay';
const TTL = 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ENVELOPE = 12 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type', 'retry-after', 'x-request-id', 'request-id',
  'x-codex-primary-used-percent', 'x-codex-primary-window-minutes',
  'x-codex-primary-reset-at', 'x-codex-secondary-used-percent',
  'x-codex-secondary-window-minutes', 'x-codex-secondary-reset-at',
  'x-codex-turn-state', 'x-models-etag', 'x-reasoning-included', 'openai-model',
  'x-codex-active-limit', 'x-codex-rate-limit-reached-type',
  'x-codex-credits-has-credits', 'x-codex-credits-unlimited', 'x-codex-credits-balance',
  'x-codex-safety-buffering-enabled', 'x-codex-safety-buffering-faster-model',
]);
const OMIT_GUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'keep-alive', 'te', 'trailer', 'expect', 'accept-encoding',
]);

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('request too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/** Local-only consent and transport. No public-proxy capabilities are changed. */
export function createCredentialRelayHandler(options: {
  allowedOrigins: readonly string[];
  /** A dedicated loopback origin serving only the permission document. */
  permissionOrigin: () => string;
  fetch?: (target: URL, init: RequestInit) => Promise<Response>;
}) {
  const allowedOrigins = Object.freeze([...options.allowedOrigins]);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw new Error('Credential relay destinations must be exact HTTPS origins');
    }
  }
  const sessions = new Map<string, { token: string; relayOrigin: string; csrf: string; approved: boolean; expiresAt: number }>();
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  async function handleCredentialRelay(
    request: IncomingMessage, response: ServerResponse, basePath: string,
    mode: "relay" | "permission" = "relay",
  ): Promise<boolean> {
    const requested = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requested.pathname;
    const base = basePath.replace(/\/$/, '');
    if (pathname !== base && !pathname.startsWith(`${base}/`)) return false;
    response.setHeader('Cache-Control', 'no-store');
    // Navigational form POSTs under no-referrer carry Origin:null. Preserve
    // the same-origin form's Origin so CSRF checks remain strict. Outbound
    // relay fetches still explicitly use no-referrer.
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    function reply(status: number, text: string, type = 'text/plain; charset=utf-8') {
      response.statusCode = status;
      response.setHeader('Content-Type', type);
      response.end(text);
    }
    // Literal loopback hosts also prevent DNS-rebinding access to this local
    // authority. Reject cross-origin requests before examining guest data.
    let origin: string;
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new Error();
      const host = new URL(`http://${request.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) throw new Error();
      const secure = 'encrypted' in request.socket && request.socket.encrypted;
      origin = `${secure ? 'https:' : 'http:'}//${host.host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw new Error();
      if (mode === 'relay' && request.headers['sec-fetch-site'] === 'cross-site') throw new Error();
      if (mode === 'permission' && origin !== options.permissionOrigin()) throw new Error();
    } catch { reply(403, 'Local same-origin access required'); return true; }
    const action = pathname.slice(base.length);
    if (mode === 'relay' && request.method === 'GET' && action === '/status') {
      const session = currentSession();
      reply(200, JSON.stringify({ approved: session?.approved === true,
        allowedOrigins, expiresAt: session?.expiresAt ?? null }), 'application/json');
      return true;
    }
    function currentSession() {
      for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
      const token = request.headers.cookie?.split(';').map(s => s.trim())
        .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const key = mode === 'permission' ? requested.searchParams.get('session') : token;
      const session = key ? sessions.get(key) : undefined;
      return session && (mode === 'permission' || session.relayOrigin === origin) ? session : undefined;
    }
    if (request.method === 'GET' && (action === '' || action === '/')) {
      let session = currentSession();
      if (mode === 'relay') {
        const permission = new URL(options.permissionOrigin());
        if (permission.protocol !== 'http:' || permission.hostname !== '127.0.0.1' ||
            permission.origin === origin || permission.href !== `${permission.origin}/`) {
          reply(500, 'An isolated loopback permission origin is required'); return true;
        }
        if (!session) {
          while (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
          const token = randomBytes(32).toString('hex');
          session = { token, relayOrigin: origin, csrf: randomBytes(32).toString('hex'), approved: false, expiresAt: Date.now() + TTL };
          sessions.set(token, session);
          response.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${base}; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
        }
        response.statusCode = 303;
        response.setHeader('Location', `${permission.origin}${base}?session=${session.token}`);
        response.end();
        return true;
      }
      if (!session) { reply(403, 'Open the permission link from Kandelo first'); return true; }
      const csrf = escapeHtml(session.csrf);
      const origins = allowedOrigins.map(s => `<li>${escapeHtml(s)}</li>`).join('');
      reply(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Credential relay permission</title><main><h1>Allow signed-in network requests?</h1><p>This relay runs on your computer at <strong>${escapeHtml(session.relayOrigin)}</strong>. Programs in this Kandelo page may send their credentials, request headers, and request bodies through it to:</p><ul>${origins}</ul><p>The local relay can read this information, including access tokens. It forwards it to the listed services over HTTPS. It does not use your browser's sign-in cookies or forward your cookies for this page.</p><p>Permission lasts up to one hour, ends when the development server restarts, and can be revoked here. It applies to all programs using this page's relay session. No credentials are relayed before you allow it.</p><p><strong>${session.approved ? 'Currently allowed' : 'Currently blocked'}</strong></p><form method="post" action="${escapeHtml(base)}/consent?session=${session.token}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="allow">Allow credential relay for one hour</button> <button name="decision" value="deny">${session.approved ? 'Revoke permission' : 'Keep blocked'}</button></form><p>After choosing, return to Kandelo. Sign in inside the guest; do not copy host credential files.</p></main></html>`, 'text/html; charset=utf-8');
      return true;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin) {
      reply(403, 'Same-origin POST required'); return true;
    }
    const session = currentSession();
    if (action === '/consent') {
      if (mode !== 'permission') { reply(403, 'Use the isolated permission page'); return true; }
      if (!session || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        reply(403, 'Open the permission page first'); return true;
      }
      try {
        const form = new URLSearchParams((await readBody(request, 4096)).toString());
        const csrf = Buffer.from(form.get('csrf') ?? '');
        const expected = Buffer.from(session.csrf);
        if (csrf.length !== expected.length || !timingSafeEqual(csrf, expected)) throw new Error();
        const decision = form.get('decision');
        if (decision !== 'allow' && decision !== 'deny') throw new Error();
        session.approved = decision === 'allow';
        response.statusCode = 303;
        response.setHeader('Location', `${base}?session=${session.token}`);
        response.end();
      } catch { reply(403, 'Permission request rejected'); }
      return true;
    }
    if (mode !== 'relay' || action !== '/request') { reply(404, 'Not found'); return true; }
    if (!session?.approved) { reply(403, 'Credential relay permission required'); return true; }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      reply(415, 'JSON envelope required'); return true;
    }
    try {
      const envelope = JSON.parse((await readBody(request, MAX_ENVELOPE)).toString());
      if (envelope.version !== 1 || typeof envelope.targetUrl !== 'string' ||
          typeof envelope.method !== 'string' || !/^[A-Z]+$/.test(envelope.method) ||
          !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(envelope.method) ||
          !Array.isArray(envelope.headers) || envelope.headers.length > 128) throw new Error();
      const target = new URL(envelope.targetUrl);
      if (target.protocol !== 'https:' || target.username || target.password ||
          !allowedOrigins.includes(target.origin)) throw new Error();
      const headers = new Headers();
      for (const pair of envelope.headers) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string')) throw new Error();
        const lower = pair[0].toLowerCase();
        if (OMIT_GUEST_HEADERS.has(lower)) continue;
        if (lower.startsWith('proxy-') || lower.startsWith('sec-')) throw new Error();
        headers.append(pair[0], pair[1]);
      }
      // Node Fetch decodes compressed responses. Request identity encoding
      // and never relay a stale Content-Encoding/Content-Length afterward.
      headers.set('accept-encoding', 'identity');
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (envelope.body !== null) {
        if (typeof envelope.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.body)) throw new Error();
        body = Buffer.from(envelope.body, 'base64');
        if (body.length > MAX_BODY || envelope.method === 'GET' || envelope.method === 'HEAD') throw new Error();
      }
      if (sessions.get(session.token) !== session || !session.approved || session.expiresAt <= Date.now()) {
        reply(403, 'Credential relay permission required'); return true;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      const abort = () => controller.abort();
      response.once('close', abort);
      try {
        const upstream = await send(target, { method: envelope.method, headers,
          body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(upstream.status)) {
          await upstream.body?.cancel(); throw new Error();
        }
        response.statusCode = upstream.status;
        upstream.headers.forEach((value, name) => {
          if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
        });
        if (upstream.body && envelope.method !== 'HEAD') {
          let bytes = 0;
          const limit = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > MAX_RESPONSE ? new Error('Relay response too large') : null, chunk);
          } });
          await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), limit, response);
        } else { await upstream.body?.cancel(); response.end(); }
      } finally { clearTimeout(timer); response.off('close', abort); }
    } catch {
      // Never include upstream URLs, envelopes, tokens, or fetch errors in
      // diagnostics. An interrupted stream must fail, not look truncated-ok.
      if (response.headersSent) response.destroy();
      else reply(502, 'Credential relay request failed');
    }
    return true;
  }
  return Object.assign(handleCredentialRelay, {
    clearPermissions() {
      for (const session of sessions.values()) session.approved = false;
      sessions.clear();
    },
  });
}
