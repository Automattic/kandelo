import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createCredentialRelayHandler } from '../vite/credential-relay';

// This server has no real provider connection. Browser consent here authorizes
// only a synthetic fixture, never the application's real credential relay.
let server: Server;
let permissionServer: Server;
let origin: string;
test.beforeAll(async () => {
  let handler!: ReturnType<typeof createCredentialRelayHandler>;
  permissionServer = createServer((req, res) => {
    handler(req, res, '/relay', 'permission').then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  await new Promise<void>(resolve => permissionServer.listen(0, '127.0.0.1', resolve));
  const permissionAddress = permissionServer.address();
  if (!permissionAddress || typeof permissionAddress === 'string') throw new Error('no permission address');
  const permissionOrigin = `http://127.0.0.1:${permissionAddress.port}`;
  handler = createCredentialRelayHandler({ allowedOrigins: ['https://provider.example'],
    permissionOrigin: () => permissionOrigin,
    fetch: async () => new Response('synthetic provider response') });
  server = createServer((req, res) => {
    handler(req, res, '/relay').then(handled => { if (!handled) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Application origin</title>Application origin'); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  for (const instance of [server, permissionServer]) {
    instance.closeAllConnections();
    await new Promise<void>(resolve => instance.close(() => resolve()));
  }
});

test('credential relay consent starts denied, grants explicitly, and revokes', async ({ page }) => {
  await page.goto(origin + '/relay');
  expect(new URL(page.url()).origin).not.toBe(origin);
  await expect(page.getByText('Currently blocked', { exact: true })).toBeVisible();
  await expect(page.getByText('https://provider.example', { exact: true })).toBeVisible();
  // The permission document deliberately forbids scripts/networking via CSP.
  // This context request shares the browser's real HttpOnly consent cookie.
  const status = () => page.request.get(origin + '/relay/status').then(r => r.json());
  expect((await status()).approved).toBe(false);
  await page.getByRole('button', { name: 'Keep blocked', exact: true }).click();
  await expect(page.getByText('Currently blocked', { exact: true })).toBeVisible();
  expect((await status()).approved).toBe(false);
  await page.getByRole('button', { name: 'Allow credential relay for one hour', exact: true }).click();
  await expect(page.getByText('Currently allowed', { exact: true })).toBeVisible();
  expect((await status()).approved).toBe(true);
  await page.screenshot({ path: fileURLToPath(new URL('../../../.context/credential-relay-consent-' + test.info().project.name + '.png', import.meta.url)) });
  await page.getByRole('button', { name: 'Revoke permission', exact: true }).click();
  await expect(page.getByText('Currently blocked', { exact: true })).toBeVisible();
  expect((await status()).approved).toBe(false);
});


test('app-origin preview scripts cannot read or grant permission', async ({ page }) => {
  await page.goto(origin + '/app');
  const redirect = await page.request.get(origin + '/relay', { maxRedirects: 0 });
  const permissionUrl = redirect.headers()['location'];
  const document = await page.request.get(permissionUrl);
  const csrf = (await document.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const result = await page.evaluate(async ({ origin, permissionUrl, csrf }) => {
    let readBlocked = false;
    try { await fetch(permissionUrl); } catch { readBlocked = true; }
    // Even deliberately giving an attacker the nonce cannot turn an app-origin
    // request into a form submission from the isolated permission document.
    const consentUrl = new URL(permissionUrl);
    consentUrl.pathname += '/consent';
    await fetch(consentUrl, { method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, decision: 'allow' }) });
    const direct = await fetch(origin + '/relay/consent', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, decision: 'allow' }) });
    const status = await (await fetch(origin + '/relay/status')).json();
    return { readBlocked, directStatus: direct.status, approved: status.approved };
  }, { origin, permissionUrl, csrf });
  expect(result).toEqual({ readBlocked: true, directStatus: 403, approved: false });
});

test('isolated approval also works when the app uses localhost', async ({ page }) => {
  const appOrigin = origin.replace('127.0.0.1', 'localhost');
  await page.goto(appOrigin + '/relay');
  const permissionUrl = page.url();
  expect(new URL(permissionUrl).hostname).toBe('127.0.0.1');
  await page.getByRole('button', { name: 'Allow credential relay for one hour', exact: true }).click();
  await expect(page.getByText('Currently allowed', { exact: true })).toBeVisible();
  await page.goto(appOrigin + '/app');
  expect(await page.evaluate(() => fetch('/relay/status').then(r => r.json()).then(s => s.approved))).toBe(true);
  await page.goto(permissionUrl);
  await page.getByRole('button', { name: 'Revoke permission', exact: true }).click();
  await expect(page.getByText('Currently blocked', { exact: true })).toBeVisible();
  await page.goto(appOrigin + '/app');
  expect(await page.evaluate(() => fetch('/relay/status').then(r => r.json()).then(s => s.approved))).toBe(false);
});
