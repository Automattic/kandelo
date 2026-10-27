import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createCredentialRelayHandler } from '../../apps/browser-demos/vite/credential-relay';
import { createCredentialRelayTransport } from '../src/networking/credential-relay';
import { BrowserCorsProxy } from '../src/networking/browser-cors-proxy';

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

async function setup(upstream = vi.fn(async () => new Response('ok'))) {
  let handler!: ReturnType<typeof createCredentialRelayHandler>;
  const permissionServer = createServer((req, res) => {
    handler(req, res, path, 'permission').then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  servers.push(permissionServer);
  await new Promise<void>(resolve => permissionServer.listen(0, '127.0.0.1', resolve));
  const permissionAddress = permissionServer.address();
  if (!permissionAddress || typeof permissionAddress === 'string') throw new Error('missing permission address');
  const permissionOrigin = `http://127.0.0.1:${permissionAddress.port}`;
  handler = createCredentialRelayHandler({ allowedOrigins: [destination], fetch: upstream, permissionOrigin: () => permissionOrigin });
  const server = createServer((req, res) => {
    handler(req, res, path).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const page = await fetch(origin + path, { redirect: 'manual' });
  const permissionUrl = page.headers.get('location')!;
  expect(new URL(permissionUrl).origin).toBe(permissionOrigin);
  expect(permissionOrigin).not.toBe(origin);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const html = await (await fetch(permissionUrl)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  async function decide(decision: string, nonce = csrf, from = permissionOrigin) {
    return fetch(permissionOrigin + path + '/consent' + new URL(permissionUrl).search, { method: 'POST', redirect: 'manual',
      headers: { Origin: from, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: nonce, decision }) });
  }
  async function send(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    headers.set('Origin', origin);
    return fetch(url, { ...init, headers });
  }
  const envelope = { version: 1, targetUrl: destination + '/responses', method: 'POST',
    headers: [['Authorization', 'Bearer synthetic-test-token'], ['originator', 'codex_cli_rs']],
    body: btoa('synthetic body') };
  function relay(value = envelope, extra: Record<string, string> = {}) {
    return send(origin + path + '/request', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  }
  return { origin, cookie, html, decide, send, relay, envelope, upstream, csrf, permissionUrl, permissionOrigin, handler };
}

describe('explicit local credential relay', () => {
  it.each(['kernel worker', 'service worker'])('%s requires consent before dispatching guest headers and body', async transport => {
    const relay = { url: 'http://localhost:5499/relay', allowedOrigins: [destination] };
    const config = { url: 'https://anonymous.example/?', allowedRequestHeaderNames: [],
      allowAnonymousGetHeaderOmission: true, credentialRelay: relay };
    let approved = false;
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const send = async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return url.endsWith('/status')
        ? Response.json({ approved, allowedOrigins: [destination] }) : new Response('provider');
    };
    const request = { method: 'POST', targetUrl: destination + '/responses',
      headers: [['Authorization', 'Bearer synthetic-test-token']] as [string, string][],
      body: 'synthetic body' };
    let dispatch: () => Promise<Response>;
    if (transport === 'kernel worker') {
      dispatch = () => new BrowserCorsProxy(config).fetch(request, send);
    } else {
      const source = readFileSync(new URL('../../apps/browser-demos/public/service-worker.js', import.meta.url), 'utf8');
      const start = source.indexOf('  var CORS_PROXY_CONFIG =');
      const end = source.indexOf('  /**\n   * Check if a URL is cross-origin', start);
      if (start < 0 || end < start) throw new Error('service worker proxy section missing');
      const section = source.slice(start, end)
        .replace('"__CORS_PROXY_CONFIG__"', JSON.stringify(config))
        .replace('"__CREDENTIAL_RELAY_TRANSPORT__"', `(${createCredentialRelayTransport.toString()})()`);
      const worker = new Function('globalThis', 'self', 'fetch', `${section}; return fetchThroughCorsProxy;`)(
        { fetch: send, location: { origin: 'http://localhost:5499' } },
        { location: { href: 'http://localhost:5499/' } }, send,
      );
      dispatch = () => worker(new Request(request.targetUrl, request), 'unused', request.targetUrl);
    }
    await dispatch().catch(() => {});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(relay.url + '/status');
    expect(JSON.stringify(sent)).not.toContain('synthetic');
    approved = true;
    sent.length = 0;
    expect(await (await dispatch()).text()).toBe('provider');
    expect(sent.map(s => s.url)).toEqual([relay.url + '/status', relay.url + '/request']);
    const envelope = JSON.parse(sent[1].init.body as string);
    expect(envelope.headers.map(([name, value]: string[]) => [name.toLowerCase(), value]))
      .toContainEqual(['authorization', 'Bearer synthetic-test-token']);
    expect(atob(envelope.body)).toBe('synthetic body');
  });

  it('does not send guest headers or body to a relay before consent', async () => {
    const send = vi.fn(async () => Response.json({ approved: false, allowedOrigins: [destination] }));
    await expect(createCredentialRelayTransport()({ url: 'http://localhost:5499' + path,
      allowedOrigins: [destination] }, { targetUrl: destination + '/responses', method: 'POST',
      headers: [['authorization', 'Bearer synthetic-test-token']], body: 'synthetic secret' }, send))
      .rejects.toThrow('requires your permission');
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain('synthetic');
  });

  it('rejects remote relays and non-allowlisted destinations before any dispatch', async () => {
    const send = vi.fn();
    const request = { targetUrl: destination, method: 'GET', headers: [] };
    await expect(createCredentialRelayTransport()({ url: 'https://untrusted.example/relay',
      allowedOrigins: [destination] }, request, send)).rejects.toThrow('local');
    await expect(createCredentialRelayTransport()({ url: 'http://localhost:5499' + path,
      allowedOrigins: [] }, request, send)).rejects.toThrow('not permitted');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not consume a streaming body before consent and bounds it after consent', async () => {
    for (const approved of [false, true]) {
      let pulled = false;
      let cancelled = false;
      const body = new ReadableStream({ pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        controller.close();
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
      const send = vi.fn(async () => Response.json({ approved, allowedOrigins: [destination] }));
      await expect(createCredentialRelayTransport()({ url: 'http://localhost:5499' + path,
        allowedOrigins: [destination] }, { targetUrl: destination, method: 'POST', headers: [], body }, send))
        .rejects.toThrow(approved ? 'exceeds 8 MiB' : 'requires your permission');
      expect(pulled).toBe(approved);
      expect(send).toHaveBeenCalledTimes(1);
      if (!approved) expect(cancelled).toBe(false);
    }
  });

  it('starts blocked and provides an explicit, framed-out permission page', async () => {
    const app = await setup();
    expect(await (await app.send(app.origin + path + '/status')).json()).toMatchObject({ approved: false });
    expect(app.html).toContain('The local relay can read this information');
    expect(app.html).toContain(destination);
    const page = await fetch(app.origin + path);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('requires the same origin, a valid CSRF token and an explicit decision', async () => {
    const app = await setup();
    expect((await app.decide('allow', 'wrong')).status).toBe(403);
    expect((await app.decide('allow', undefined, 'https://untrusted.example')).status).toBe(403);
    expect((await app.decide('implicit')).status).toBe(403);
    expect((await app.decide('deny')).status).toBe(303);
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('rejects app-origin consent even with a known permission nonce', async () => {
    const app = await setup();
    expect((await app.decide('allow', app.csrf, app.origin)).status).toBe(403);
    const response = await app.send(app.origin + path + '/consent', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: app.csrf, decision: 'allow' }) });
    expect(response.status).toBe(403);
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('preserves explicit guest credentials while excluding ambient browser credentials', async () => {
    const app = await setup();
    await app.decide('allow');
    const result = await createCredentialRelayTransport()({ url: app.origin + path,
      allowedOrigins: [destination] }, { targetUrl: destination + '/responses', method: 'POST',
      headers: [['Authorization', 'Bearer synthetic-test-token'], ['originator', 'codex_cli_rs']],
      body: 'synthetic body' }, app.send);
    expect(await result.text()).toBe('ok');
    expect(app.upstream).toHaveBeenCalledTimes(1);
    const [url, init] = app.upstream.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(destination + '/responses');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-test-token');
    expect(headers.get('originator')).toBe('codex_cli_rs');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('origin')).toBe(false);
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('synthetic body');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('revokes previously granted permission', async () => {
    const app = await setup();
    await app.decide('allow');
    expect((await app.relay()).status).toBe(200);
    await app.decide('deny');
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });

  it('clears permission when the local server restarts', async () => {
    const app = await setup();
    await app.decide('allow');
    app.handler.clearPermissions();
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('expires consent instead of silently renewing permission', async () => {
    const app = await setup();
    await app.decide('allow');
    const later = Date.now() + 60 * 60 * 1000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await app.relay()).status).toBe(403);
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('does not follow redirects or forward privileged upstream response headers', async () => {
    const redirected = await setup(vi.fn(async () => Response.redirect('https://untrusted.example')));
    await redirected.decide('allow');
    expect((await redirected.relay()).status).toBe(502);
    const safe = await setup(vi.fn(async () => new Response('ok', { headers: {
      'Set-Cookie': 'ambient=forged', 'Clear-Site-Data': '"*"', 'Content-Type': 'text/event-stream',
      'x-codex-turn-state': 'synthetic-turn-state',
    } })));
    await safe.decide('allow');
    const response = await safe.relay();
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('clear-site-data')).toBe(false);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-codex-turn-state')).toBe('synthetic-turn-state');
    expect(await response.text()).toBe('ok');
  });

  it('rejects non-allowlisted or credential-bearing destination URLs server-side', async () => {
    const app = await setup();
    await app.decide('allow');
    for (const targetUrl of ['https://untrusted.example', 'http://provider.example', 'https://user:secret@provider.example']) {
      const response = await app.relay({ ...app.envelope, targetUrl });
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('secret');
    }
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it('streams the first response chunk before the upstream response completes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const app = await setup(vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })));
    await app.decide('allow');
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    const response = await app.relay();
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first');
    controller.enqueue(new TextEncoder().encode('data: last\n\n'));
    controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: last');
    expect((await reader.read()).done).toBe(true);
  });
});
