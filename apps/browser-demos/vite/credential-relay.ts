import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  CORS_PROXY_ALLOWED_REQUEST_HEADERS_HEADER,
  CREDENTIAL_GRANT_REQUEST_HEADER,
  GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES,
} from '../../../host/src/networking/browser-cors-proxy';
import { CREDENTIAL_RELAY_MAX_BODY_BYTES } from '../../../host/src/networking/credential-relay';
import { devCorsProxyRequestHeaders } from './dev-cors-proxy';

const MAX_RESPONSE = 64 * 1024 * 1024;
const TIMEOUT = 10 * 60 * 1000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const OPT_IN = CORS_PROXY_ALLOWED_REQUEST_HEADERS_HEADER.toLowerCase();
const TAG = CREDENTIAL_GRANT_REQUEST_HEADER.toLowerCase();
// What the relay copies back. It answers from Kandelo's own origin, so an
// arbitrary upstream header would gain that origin's authority (cookies,
// Clear-Site-Data, ...). These are inert payload and Codex protocol fields.
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

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

/**
 * The loopback development relay for signed-in HTTPS traffic.
 *
 * It speaks the CORS proxy protocol (`<path>?url=<target>`, guest fields as
 * request fields) to a fixed list of HTTPS origins, and carries a credential
 * only on a request that opts in to it with
 * `X-Cors-Proxy-Allowed-Request-Headers`. In the browser app only the
 * service worker's credential gate writes that opt-in, after the kernel
 * worker that holds the process's credential grant vouched for the request,
 * and the gate removes the grant's tag. So:
 *
 * - credentials without the opt-in are refused (403), never stripped;
 * - a request still carrying the tag never passed the gate, and is refused;
 * - there is no approval page, session or cookie: the per-process grant is
 *   the only permission.
 *
 * It cannot tell the service worker from any other same-origin script that
 * writes the opt-in itself (a page the service worker does not control, for
 * one). The app's origin is the trusted boundary here, as it is for the
 * gate; see docs/browser-support.md, "Development credential relay".
 */
export function createCredentialRelayHandler(options: {
  allowedOrigins: readonly string[];
  fetch?: (target: URL, init: RequestInit) => Promise<Response>;
}) {
  const allowedOrigins = Object.freeze([...options.allowedOrigins]);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw new Error('Credential relay destinations must be exact HTTPS origins');
    }
  }
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  return async function handleCredentialRelay(
    request: IncomingMessage, response: ServerResponse, relayPath: string,
  ): Promise<boolean> {
    const requested = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requested.pathname;
    if (pathname !== relayPath && !pathname.startsWith(`${relayPath}/`)) return false;
    // Every answer is data for fetch(), never this origin's code or document.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', 'sandbox');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    function reply(status: number, text: string) {
      response.statusCode = status;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(`${text}\n`);
    }
    // The relay is the endpoint itself; the former approval page, status and
    // consent paths no longer exist.
    const target = pathname === relayPath ? requested.searchParams.get('url') : null;
    if (target === null) { reply(404, 'Not found'); return true; }

    // Literal loopback hosts also prevent DNS-rebinding access to this local
    // authority. Refuse other origins before examining guest data.
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new Error();
      const host = new URL(`http://${request.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) throw new Error();
      const secure = 'encrypted' in request.socket && request.socket.encrypted;
      const origin = `${secure ? 'https:' : 'http:'}//${host.host}`;
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new Error();
      const site = headerValue(request.headers['sec-fetch-site']);
      if (site !== undefined && site !== 'same-origin') throw new Error();
    } catch { reply(403, 'The credential relay answers only its own local origin'); return true; }
    const destination = headerValue(request.headers['sec-fetch-dest']);
    if (destination !== undefined && destination !== 'empty') {
      reply(403, `The credential relay answers only fetch(), not a load as ${destination}`);
      return true;
    }
    if (request.headers[TAG] !== undefined) {
      // The service worker's gate removes the tag once the kernel worker has
      // vouched for it. A request that still has one never passed that gate
      // (an uncontrolled page or worker, or a forced reload).
      reply(403, 'This request carries a Kandelo credential grant tag, so it did not pass the service worker\'s credential gate');
      return true;
    }
    const method = request.method?.toUpperCase() ?? '';
    if (!METHODS.has(method)) { reply(405, 'Method Not Allowed'); return true; }

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch { reply(400, 'Invalid target URL'); return true; }
    if (targetUrl.protocol !== 'https:' || targetUrl.username || targetUrl.password ||
        targetUrl.hash || !allowedOrigins.includes(targetUrl.origin)) {
      reply(403, 'The target is not one of the credential relay\'s HTTPS destinations');
      return true;
    }

    // A credential passes only with the opt-in, which may name only what a
    // grant relays. ChatGPT-Account-ID, which proxies relay as an ordinary
    // field, still needs the opt-in to be present here.
    const optInValue = headerValue(request.headers[OPT_IN]);
    const optedIn = optInValue === undefined ? undefined : optInValue.split(',')
      .map(name => name.trim().toLowerCase()).filter(name => name !== '');
    const credentials = [...GRANTED_CREDENTIAL_REQUEST_HEADER_NAMES]
      .filter(name => request.headers[name] !== undefined);
    if (optedIn?.some(name => name !== 'authorization')) {
      reply(403, 'The credential opt-in names fields the relay never carries');
      return true;
    }
    // An opt-in that names nothing is no opt-in: the gate always names
    // Authorization.
    if (credentials.length > 0 && (optedIn === undefined ||
        !optedIn.includes('authorization'))) {
      reply(403, 'This request carries credentials without the credential opt-in that only a Kandelo credential grant produces');
      return true;
    }

    let headers: Headers;
    let body: Buffer | undefined;
    try {
      // Reviewed, inert fields only (the same profile as the development CORS
      // proxy): never the browser's own Cookie, Origin, or Sec-* fields.
      headers = devCorsProxyRequestHeaders(request.headers);
      for (const name of credentials) headers.set(name, headerValue(request.headers[name])!);
      // Node Fetch decodes compressed responses. Request identity encoding
      // and never relay a stale Content-Encoding/Content-Length afterward.
      headers.set('accept-encoding', 'identity');
      const bytes = await readBody(request, CREDENTIAL_RELAY_MAX_BODY_BYTES);
      if (bytes.length > 0) {
        if (method === 'GET' || method === 'HEAD') throw new Error();
        body = bytes;
      }
    } catch {
      request.resume();
      reply(400, 'The credential relay could not read this request');
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', abort);
    try {
      const upstream = await send(targetUrl, { method, headers, body,
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        await upstream.body?.cancel(); throw new Error();
      }
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
      });
      if (upstream.body && method !== 'HEAD') {
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_RESPONSE ? new Error('Relay response too large') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), limit, response);
      } else { await upstream.body?.cancel(); response.end(); }
    } catch {
      // Never include upstream URLs, tokens, or fetch errors in diagnostics.
      // An interrupted stream must fail, not look truncated-ok.
      if (response.headersSent) response.destroy();
      else reply(502, 'Credential relay request failed');
    } finally {
      clearTimeout(timer);
      response.off('close', abort);
    }
    return true;
  };
}
