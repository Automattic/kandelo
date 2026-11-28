import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { setDefaultCACertificates } from 'node:tls';

function key(name) {
  return readFileSync(new URL('../fixtures/keys/' + name, import.meta.url), 'utf8');
}

const fileBytes = Buffer.from([0, 13, 10, 255, 45, 0, 128]);
const upload = new FormData();
upload.append('tag', 'first');
upload.append('tag', 'second');
upload.append('sample', new Blob([fileBytes], { type: 'application/octet-stream' }), 'sample.bin');

const responseBoundary = 'KandeloControlledResponse';
const responseParts = [
  `--${responseBoundary}\r\nContent-Disposition: form-data; name="status"\r\n\r\nreceived\r\n`,
  `--${responseBoundary}\r\nContent-Disposition: form-data; name="echo"; filename="echo.bin"\r\n`,
  'Content-Type: application/octet-stream\r\n\r\n',
  fileBytes,
  `\r\n--${responseBoundary}--\r\n`,
];

let requestFailure;
let requestCount = 0;
const server = createServer({ cert: key('agent8-cert.pem'), key: key('agent8-key.pem') }, async (request, response) => {
  try {
    requestCount++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/multipart');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const boundary = /^multipart\/form-data; boundary=([A-Za-z0-9_-]+)$/.exec(request.headers['content-type']);
    assert.ok(boundary);
    const parts = Buffer.concat(chunks).toString('latin1').split('--' + boundary[1]);
    assert.equal(parts.length, 5);
    assert.equal(parts[0], '');
    assert.equal(parts[1], '\r\nContent-Disposition: form-data; name="tag"\r\n\r\nfirst\r\n');
    assert.equal(parts[2], '\r\nContent-Disposition: form-data; name="tag"\r\n\r\nsecond\r\n');
    assert.equal(parts[3], '\r\nContent-Disposition: form-data; name="sample"; filename="sample.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' + fileBytes.toString('latin1') + '\r\n');
    assert.match(parts[4], /^--(?:\r\n)?$/);
  } catch (error) {
    requestFailure = error;
    response.writeHead(500).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': `multipart/form-data; boundary=${responseBoundary}` });
  for (const part of responseParts) response.write(part);
  response.end();
});

setDefaultCACertificates([key('fake-startcom-root-cert.pem')]);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const response = await fetch(`https://localhost:${server.address().port}/multipart`, {
    method: 'POST', body: upload,
  });
  assert.ifError(requestFailure);
  assert.equal(response.status, 200);
  assert.equal(response.bodyUsed, false);
  const result = await response.formData();
  assert.equal(response.bodyUsed, true);
  assert.equal(result.get('status'), 'received');
  const echo = result.get('echo');
  assert.ok(echo instanceof File);
  assert.equal(echo.name, 'echo.bin');
  assert.equal(echo.type, 'application/octet-stream');
  assert.deepEqual(Buffer.from(await echo.arrayBuffer()), fileBytes);
  await assert.rejects(response.formData(), TypeError);
  assert.equal(requestCount, 1);
} finally {
  const closing = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closing;
}
