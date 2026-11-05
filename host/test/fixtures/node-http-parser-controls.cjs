'use strict';
// Compare actual portable owner/native Node parsers. No guest/host conformance
// is inferred from these native dependency boundaries.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const target = JSON.parse(fs.readFileSync(path.join(root, 'packages/registry/node-compat/target.json')));
assert.equal(process.version, `v${target.version}`);
const { create } = require('./node-http-parser-reference.cjs');
const cases = [
  ['fixed Latin1 and duplicate headers', 'HTTP/1.1 200 Fine\r\nContent-Length: 4\r\nX-A: one \t\r\nX-A: \xff\r\nEmpty:\r\n\r\na\0\xffz'],
  ['one-byte fragmentation', 'HTTP/1.1 200 \r\nTransfer-Encoding: chunked\r\n\r\n3;x=y\r\nabc\r\n0\r\nT-End: yes \t\r\n\r\n', { width: 1 }],
  ['interim responses then final', 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'],
  ['HEAD skips advertised body', 'HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n', { method: 'HEAD' }],
  ['ordinary completion leaves unsolicited response', 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nattack'],
  ['CONNECT exact tunnel head', 'HTTP/1.1 200 Connection established\r\n\r\n\x00\xfftunnel', { method: 'CONNECT' }],
  ['upgrade exact head', 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n\xffhead'],
  ['EOF-delimited body', 'HTTP/1.0 200 OK\r\n\r\nbody', { width: 2 }],
  ['204 no body', 'HTTP/1.1 204 No Content\r\nContent-Length: 12\r\n\r\n'],
  ['invalid content length', 'HTTP/1.1 200 OK\r\nContent-Length: 2z\r\n\r\nxx'],
  ['sticky error after retired fragmented input', 'HTTP/1.1 200 OK\r\nContent-Length: 2z\r\n\r\nxx', { width: 1 }],
  ['duplicate content length', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nxx'],
  ['conflicting framing', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'],
  ['invalid chunk size', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2z\r\nxx\r\n0\r\n\r\n'],
  ['invalid header token', 'HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n'],
  ['invalid header value', 'HTTP/1.1 200 OK\r\nX: \x01\r\n\r\n'],
  ['insecure parser option', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX: \x01\r\n\r\nx', { insecure: true }],
  ['relaxed header value option', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX: \x7f\r\n\r\nx', { relaxed: true }],
  ['truncated fixed body', 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort'],
  ['truncated chunk body', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nxx'],
  ['exact header overflow boundary', 'HTTP/1.1 200 OK\r\nX: 12345\r\n\r\n', { limit: 8 }],
  ['header below limit', 'HTTP/1.1 200 OK\r\nX: 12345\r\n\r\n', { limit: 9 }],
  ['trailer overflow', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: ' + 'a'.repeat(64) + '\r\n\r\n', { limit: 40 }],
  ['chunk extension overflow', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;' + 'x'.repeat(16385) + '=y\r\nx\r\n0\r\n\r\n'],
  ['empty input', ''],
];
function canonical(steps) {
  const out = { headers: [], body: '', trailers: [], code: '', reason: '', complete: false, upgrade: false, remainder: '' };
  for (const step of steps) {
    for (const event of step.events) {
      if (event.type === 0) out.headers.push(Object.fromEntries(['headers', 'status', 'major', 'minor', 'keepAlive', 'upgrade', 'informational', 'statusMessage'].map(k => [k, event[k]])));
      if (event.type === 1) out.body += event.body;
      if (event.type === 2 && !event.informational) out.trailers.push(...event.headers);
    }
    out.complete ||= step.complete; out.upgrade ||= step.upgrade;
    out.remainder += step.remainder;
    if (step.code && !out.code) { out.code = step.code; out.reason = step.reason; }
  }
  return out;
}
const results = [];
for (const [name, raw, options = {}] of cases) {
  try {
    const bytes = Buffer.from(raw, 'latin1'), chunks = [];
    for (let at = 0; at < bytes.length; at += options.width || bytes.length) chunks.push(bytes.subarray(at, at + (options.width || bytes.length)));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    const native = create(options.method, options.limit, options.insecure, options.relaxed), reference = [];
    try { for (const chunk of chunks) reference.push(native.feed(chunk)); reference.push(native.finish()); }
    finally { native.close(); }
    const candidate = spawnSync(process.env.KANDELO_HTTP_PARSER_OWNER || path.join(root, '.context/node26-http-parser-native/owner'),
      [options.method || 'GET', String(options.limit || 0), options.insecure ? '1' : options.relaxed ? '2' : '0'],
      { input: chunks.map(c => c.toString('hex')).concat('finish', 'finish').join('\n') + '\n', encoding: 'utf8' });
    assert.equal(candidate.status, 0, candidate.stderr);
    const steps = candidate.stdout.trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(canonical(steps), canonical(reference));
    // Every failed parser keeps the actual first failure without reading a
    // stale error_pos on a later EOF; completed feeds never reparse leftovers.
    if (steps.at(-2).code) assert.equal(steps.at(-1).code, steps.at(-2).code);
    results.push({ name, status: 'pass' });
  } catch (error) { results.push({ name, status: 'fail', error: error.stack }); }
}
const report = { target: target.version, boundary: 'portable C++/llhttp owner against native Node HTTPParser; no guest cases',
  cases: results.length, passed: results.filter(r => r.status === 'pass').length, results };
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.cases) process.exitCode = 1;
