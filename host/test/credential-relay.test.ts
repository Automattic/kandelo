import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createCredentialRelayHandler } from '../../apps/browser-demos/vite/credential-relay';
import {
  BrowserCorsProxy,
  BrowserCorsProxyRequestError,
} from '../src/networking/browser-cors-proxy';
import { createProxySessionTransport } from '../src/networking/cors-proxy-session';

// The development credential relay carries credentials only for a request
// the service worker's gate produced: one with the proxy protocol's opt-in
// and without the grant's tag. It has no approval page and no site-wide
// session; a per-process credential grant is the only permission.

const destination = 'https://provider.example';
const path = '/__kandelo_credential_relay';
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function setup(upstream = vi.fn(async (_url: URL, _init: RequestInit) => new Response('ok'))) {
  const handler = createCredentialRelayHandler({ allowedOrigins: [destination], fetch: upstream });
  const server = createServer((req, res) => {
    handler(req, res, path).then(handled => { if (!handled) { res.statusCode = 200; res.end('app shell'); } });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const relayUrl = (target = destination + '/responses') => `${origin}${path}?url=${encodeURIComponent(target)}`;
  function relay(headers: Record<string, string> = {}, init: RequestInit = {}, target?: string) {
    return fetch(relayUrl(target), { method: 'POST', body: 'synthetic body', ...init,
      headers: { 'Content-Type': 'application/json', ...headers } });
  }
  function forwarded(index = 0) {
    const [url, init] = upstream.mock.calls[index] as unknown as [URL, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
  }
  return { origin, relayUrl, relay, upstream, forwarded };
}

const GRANTED = {
  Authorization: 'Bearer synthetic-test-token',
  'ChatGPT-Account-ID': 'synthetic-account',
  'X-Cors-Proxy-Allowed-Request-Headers': 'Authorization',
};

describe('development credential relay server', () => {
  it('has no approval page, status, or consent endpoint', async () => {
    const app = await setup();
    for (const [method, suffix] of [['GET', ''], ['GET', '/'], ['GET', '/status'], ['POST', '/consent'], ['POST', '/request']]) {
      const response = await fetch(app.origin + path + suffix, { method, redirect: 'manual' });
      expect(response.status, `${method} ${suffix}`).toBe(404);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.get('content-security-policy')).toBe('sandbox');
    }
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('forwards credentials for a request carrying the opt-in', async () => {
    const app = await setup();
    const response = await app.relay({ ...GRANTED, originator: 'codex_cli_rs', Cookie: 'ambient=browser' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(app.upstream).toHaveBeenCalledTimes(1);
    const { url, init, headers } = app.forwarded();
    expect(url.href).toBe(destination + '/responses');
    expect(headers.get('authorization')).toBe('Bearer synthetic-test-token');
    expect(headers.get('chatgpt-account-id')).toBe('synthetic-account');
    expect(headers.get('originator')).toBe('codex_cli_rs');
    // The opt-in instructs the relay; the browser's own cookie and Origin are
    // not the guest's and are never forwarded.
    expect(headers.has('x-cors-proxy-allowed-request-headers')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('origin')).toBe(false);
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('synthetic body');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('refuses credentials without the opt-in, visibly and without stripping them', async () => {
    const app = await setup();
    for (const headers of [
      { Authorization: 'Bearer synthetic-test-token' },
      { 'ChatGPT-Account-ID': 'synthetic-account' },
      // An opt-in that names nothing is no opt-in.
      { 'ChatGPT-Account-ID': 'synthetic-account', 'X-Cors-Proxy-Allowed-Request-Headers': '' },
      // The opt-in must name Authorization for Authorization to pass.
      { Authorization: 'Bearer synthetic-test-token', 'X-Cors-Proxy-Allowed-Request-Headers': 'Content-Type' },
      // The opt-in may name only what a grant relays.
      { 'X-Cors-Proxy-Allowed-Request-Headers': 'Authorization, Cookie' },
    ]) {
      const response = await app.relay(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      const body = await response.text();
      expect(body).toContain('opt-in');
      expect(body).not.toContain('synthetic');
    }
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('refuses a request that still carries a grant tag: it bypassed the service worker gate', async () => {
    const app = await setup();
    const response = await app.relay({ ...GRANTED, 'X-Kandelo-Credential-Grant': 'synthetic-tag' });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain('service worker');
    expect(body).not.toContain('synthetic-tag');
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('relays an anonymous request without any opt-in', async () => {
    const app = await setup();
    const response = await fetch(app.relayUrl(destination + '/models?client=1'));
    expect(response.status).toBe(200);
    expect(app.forwarded().url.href).toBe(destination + '/models?client=1');
    expect(app.forwarded().headers.has('authorization')).toBe(false);
  });

  it('forwards only to its exact HTTPS destinations', async () => {
    const app = await setup();
    for (const target of ['https://untrusted.example/x', 'http://provider.example/x',
      'https://user:secret@provider.example/x', 'not a url']) {
      const response = await app.relay(GRANTED, {}, target);
      expect(response.status, target).toBeGreaterThanOrEqual(400);
      expect(response.status, target).toBeLessThan(500);
      expect(await response.text()).not.toContain('secret');
    }
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('answers only fetch(), from its own origin, as inert data', async () => {
    const app = await setup();
    const script = await app.relay({ ...GRANTED, 'Sec-Fetch-Dest': 'script' }, { method: 'GET', body: undefined });
    expect(script.status).toBe(403);
    expect(script.headers.get('content-security-policy')).toBe('sandbox');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    const crossSite = await app.relay({ ...GRANTED, 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const otherOrigin = await app.relay({ ...GRANTED, Origin: 'https://untrusted.example' });
    expect(otherOrigin.status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
    const ok = await app.relay({ ...GRANTED, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'same-origin', Origin: app.origin });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toBe('sandbox');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not follow redirects or forward privileged upstream response headers', async () => {
    const redirected = await setup(vi.fn(async () => Response.redirect('https://untrusted.example')));
    expect((await redirected.relay(GRANTED)).status).toBe(502);
    const safe = await setup(vi.fn(async () => new Response('ok', { headers: {
      'Set-Cookie': 'ambient=forged', 'Clear-Site-Data': '"*"', 'Content-Type': 'text/event-stream',
      'x-codex-turn-state': 'synthetic-turn-state',
    } })));
    const response = await safe.relay(GRANTED);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('clear-site-data')).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-codex-turn-state')).toBe('synthetic-turn-state');
    expect(await response.text()).toBe('ok');
  });

  it('copies back every response field Codex reads, as the Spacefast proxy exposes them', async () => {
    const codexFields = [
      'x-codex-turn-state', 'openai-model', 'x-models-etag', 'x-reasoning-included',
      'x-codex-primary-used-percent', 'x-codex-primary-window-minutes', 'x-codex-primary-reset-at',
      'x-codex-secondary-used-percent', 'x-codex-secondary-window-minutes', 'x-codex-secondary-reset-at',
      'x-codex-limit-name', 'x-codex-credits-has-credits', 'x-codex-credits-unlimited',
      'x-codex-credits-balance', 'x-codex-promo-message', 'x-codex-rate-limit-reached-type',
      'x-codex-active-limit', 'x-codex-safety-buffering-enabled', 'x-codex-safety-buffering-faster-model',
      'retry-after', 'x-request-id', 'x-oai-request-id', 'cf-ray', 'x-openai-authorization-error',
      'x-error-json',
    ];
    const app = await setup(vi.fn(async () => new Response('ok', {
      headers: Object.fromEntries(codexFields.map(name => [name, `synthetic-${name}`])),
    })));
    const response = await app.relay(GRANTED);
    for (const name of codexFields) expect(response.headers.get(name), name).toBe(`synthetic-${name}`);
  });

  it('streams the first response chunk before the upstream response completes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const app = await setup(vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })));
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    const response = await app.relay(GRANTED);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first');
    controller.enqueue(new TextEncoder().encode('data: last\n\n'));
    controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: last');
    expect((await reader.read()).done).toBe(true);
  });
});

const relayConfig = { url: 'http://localhost:5499' + path, allowedOrigins: [destination] };
const proxyConfig = { url: 'https://anonymous.example/?', allowedRequestHeaderNames: ['content-type', 'originator'],
  allowAnonymousGetHeaderOmission: true, credentialRelay: relayConfig };
const relayed = `${relayConfig.url}?url=${encodeURIComponent(destination + '/responses')}`;

describe('kernel worker transport to the development relay', () => {
  function capture() {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const send = async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response('provider'); };
    return { sent, send };
  }
  const request = { method: 'POST', targetUrl: destination + '/responses',
    headers: [['Authorization', 'Bearer synthetic-test-token'], ['originator', 'codex_cli_rs']] as [string, string][],
    body: 'synthetic body' };

  it('sends a granted request to the relay with the opt-in and the tag', async () => {
    const { sent, send } = capture();
    const response = await new BrowserCorsProxy(proxyConfig).fetch(request, send, { token: 'synthetic-tag' });
    expect(await response.text()).toBe('provider');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(relayed);
    const headers = new Headers(sent[0].init.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-test-token');
    expect(headers.get('x-cors-proxy-allowed-request-headers')).toBe('Authorization');
    // The service worker verifies and removes the tag on its way to the relay.
    expect(headers.get('x-kandelo-credential-grant')).toBe('synthetic-tag');
    expect(sent[0].init.credentials).toBe('omit');
    expect(sent[0].init.body).toBe('synthetic body');
  });

  it('refuses an ungranted credential before anything reaches the relay', async () => {
    const { sent, send } = capture();
    await expect(new BrowserCorsProxy(proxyConfig).fetch(request, send))
      .rejects.toBeInstanceOf(BrowserCorsProxyRequestError);
    expect(sent).toEqual([]);
  });

  it('keeps anonymous requests to relay destinations on the relay, and others on the proxy', async () => {
    const { sent, send } = capture();
    await new BrowserCorsProxy(proxyConfig).fetch({ method: 'GET', targetUrl: destination + '/models', headers: [] }, send);
    await new BrowserCorsProxy(proxyConfig).fetch({ method: 'GET', targetUrl: 'https://other.example/a', headers: [] }, send);
    expect(sent.map(({ url }) => url)).toEqual([
      `${relayConfig.url}?url=${encodeURIComponent(destination + '/models')}`,
      'https://anonymous.example/?https://other.example/a',
    ]);
    expect(new Headers(sent[0].init.headers).has('x-cors-proxy-allowed-request-headers')).toBe(false);
  });
});

describe('service worker transport to the development relay', () => {
  // Run the service worker's own proxy-dispatch code, as the parity test does.
  function serviceWorkerDispatch() {
    const source = readFileSync(new URL('../../apps/browser-demos/public/service-worker.js', import.meta.url), 'utf8');
    const start = source.indexOf('  var CORS_PROXY_CONFIG =');
    const end = source.indexOf('  /**\n   * Check if a URL is cross-origin', start);
    if (start < 0 || end < start) throw new Error('service worker proxy section missing');
    const section = source.slice(start, end)
      .replace('"__CORS_PROXY_CONFIG__"', JSON.stringify(proxyConfig))
      .replace('"__CORS_PROXY_SESSION_TRANSPORT__"', `(${createProxySessionTransport.toString()})`);
    const sent: Array<{ url: string; credentials: RequestCredentials; headers: Record<string, string>; body: string }> = [];
    const send = async (input: Request) => {
      sent.push({ url: input.url, credentials: input.credentials,
        headers: Object.fromEntries(input.headers.entries()), body: await input.text() });
      return new Response('provider');
    };
    const dispatch = new Function('self', 'console', 'fetch', `${section}; return fetchThroughCorsProxy;`)(
      { location: new URL('http://localhost:5499/') }, console, send,
    ) as (request: Request, outgoingUrl: string, targetUrl: string, grant?: { token: string } | null) => Promise<Response>;
    return { dispatch, sent };
  }

  function guestRequest(extra: Record<string, string> = {}) {
    return new Request(destination + '/responses', { method: 'POST', body: 'synthetic body',
      headers: { Authorization: 'Bearer synthetic-test-token', originator: 'codex_cli_rs', ...extra } });
  }

  it('relays a verified grant with the re-derived opt-in and without the tag', async () => {
    const { dispatch, sent } = serviceWorkerDispatch();
    const response = await dispatch(guestRequest({
      'X-Kandelo-Credential-Grant': 'synthetic-tag',
      'X-Cors-Proxy-Allowed-Request-Headers': 'Authorization, Cookie',
    }), relayed, destination + '/responses', { token: 'synthetic-tag' });
    expect(await response.text()).toBe('provider');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(relayed);
    expect(sent[0].credentials).toBe('omit');
    expect(sent[0].headers.authorization).toBe('Bearer synthetic-test-token');
    expect(sent[0].headers['x-cors-proxy-allowed-request-headers']).toBe('Authorization');
    expect(sent[0].headers['x-kandelo-credential-grant']).toBeUndefined();
    expect(sent[0].body).toBe('synthetic body');
  });

  it('never sends an unverified credential to the relay', async () => {
    const { dispatch, sent } = serviceWorkerDispatch();
    const response = await dispatch(guestRequest(), relayed, destination + '/responses', null);
    expect(response.status).toBe(502);
    expect(sent).toEqual([]);
  });

  it('routes a proxy-bound request for a relay destination to the relay', async () => {
    const { dispatch, sent } = serviceWorkerDispatch();
    await dispatch(new Request(destination + '/models'), 'https://anonymous.example/?' + destination + '/models',
      destination + '/models', null);
    expect(sent.map(({ url }) => url)).toEqual([`${relayConfig.url}?url=${encodeURIComponent(destination + '/models')}`]);
  });
});
