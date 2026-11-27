import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { setDefaultCACertificates } from 'node:tls';

function key(name) {
  return readFileSync(new URL('../fixtures/keys/' + name, import.meta.url), 'utf8');
}

const options = { cert: key('agent8-cert.pem'), key: key('agent8-key.pem') };
const expectedPayload = 'replayable HTTPS request body';

async function open(handler) {
  const server = createServer(options, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `https://localhost:${server.address().port}` };
}

const received = [];
const local = [];
async function record(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return {
    url: req.url,
    method: req.method,
    body: Buffer.concat(chunks).toString(),
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
  };
}

setDefaultCACertificates([key('fake-startcom-root-cert.pem')]);
const destination = await open(async (req, res) => {
  received.push(await record(req));
  res.end('redirect destination');
});
const origin = await open(async (req, res) => {
  local.push(await record(req));
  const routes = {
    '/post-to-get': [303, '/local'],
    '/replay-post': [307, '/local'],
    '/cross-origin': [302, destination.url + '/other'],
  };
  const redirect = routes[req.url];
  if (redirect) {
    const [status, location] = redirect;
    res.writeHead(status, { Location: location });
    res.end();
  } else {
    assert.equal(req.url, '/local');
    res.end('redirect local');
  }
});

try {
  const asGet = await fetch(origin.url + '/post-to-get', { method: 'POST', body: expectedPayload });
  assert.equal(asGet.redirected, true);
  assert.equal(asGet.url, origin.url + '/local');
  assert.equal(await asGet.text(), 'redirect local');

  const replayed = await fetch(origin.url + '/replay-post', { method: 'POST', body: expectedPayload });
  assert.equal(replayed.redirected, true);
  assert.equal(await replayed.text(), 'redirect local');
  assert.deepEqual(local.splice(0).map(({ url, method, body }) => [url, method, body]), [
    ['/post-to-get', 'POST', expectedPayload],
    ['/local', 'GET', ''],
    ['/replay-post', 'POST', expectedPayload],
    ['/local', 'POST', expectedPayload],
  ]);

  const manual = await fetch(origin.url + '/cross-origin', { redirect: 'manual' });
  assert.equal(manual.status, 302);
  assert.equal(manual.redirected, false);
  assert.equal(manual.headers.get('location'), destination.url + '/other');
  await manual.text();
  await assert.rejects(fetch(origin.url + '/cross-origin', { redirect: 'error' }), TypeError);
  assert.deepEqual(received, []);

  const externalOrigin = await fetch(origin.url + '/cross-origin', {
    headers: { Authorization: 'Bearer test-sentinel', Cookie: 'test=sentinel' },
  });
  assert.equal(externalOrigin.url, destination.url + '/other');
  assert.equal(await externalOrigin.text(), 'redirect destination');
  assert.equal(local.at(-1).authorization, 'Bearer test-sentinel');
  assert.equal(local.at(-1).cookie, 'test=sentinel');
  assert.deepEqual(received, [{
    url: '/other', method: 'GET', body: '', authorization: undefined, cookie: undefined,
  }]);
} finally {
  await Promise.all([origin.server, destination.server].map(server =>
    new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
}
