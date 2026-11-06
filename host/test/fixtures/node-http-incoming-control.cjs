'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const stream = require('node:stream');
const { once } = require('node:events');
const target = require('../../../packages/registry/node-compat/target.json');
assert.equal(process.versions.node, target.version);
const { create } = require('./node-http-incoming-platform.cjs');
const subject = create();
function socket() { return new stream.Duplex({ read() {}, write(_b, _e, cb) { cb(); } }); }
function descriptors(ctor) {
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(ctor.prototype)).map(([k, d]) => [k, {
    enumerable: d.enumerable, configurable: d.configurable, writable: d.writable,
    value: typeof d.value === 'function' ? [d.value.name, d.value.length] : d.value,
    get: d.get && [d.get.name, d.get.length], set: d.set && [d.set.name, d.set.length],
  }]));
}
async function receive(api, fragments, options = {}) {
  const peers = new Set();
  const server = net.createServer(peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.once('data', async () => {
      for (const part of fragments) {
        if (peer.destroyed) return;
        peer.write(part, 'latin1');
        await new Promise(resolve => setImmediate(resolve));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let req;
  try {
    return await new Promise((resolve, reject) => {
      req = api.get({ hostname: '127.0.0.1', port: server.address().port, ...options }, res => {
        const output = { instance: res instanceof api.IncomingMessage,
          socket: res.socket === req._socket || res.socket === req.socket,
          headers: res.headers, distinct: res.headersDistinct, raw: res.rawHeaders, parts: [], aborted: [] };
        const signal = res.signal;
        res.on('aborted', () => output.aborted.push('aborted'));
        res.on('data', part => output.parts.push(...part));
        res.on('error', reject);
        res.on('end', () => {
          output.trailers = res.trailers; output.trailersDistinct = res.trailersDistinct;
          output.rawTrailers = res.rawTrailers; output.complete = res.complete;
          output.signalAborted = signal.aborted;
          resolve(output);
        });
      });
      req.on('error', reject);
    });
  } finally {
    req?.destroy(); for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
async function exchange(api, raw, options = {}, event = 'response') {
  const peers = new Set(), information = [], trace = [];
  const server = net.createServer(peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.once('data', () => peer.end(Buffer.from(raw, 'latin1')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let req, timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP control timed out')), 5000);
      req = api.request({ hostname: '127.0.0.1', port: server.address().port, ...options });
      req.on('continue', () => trace.push('continue'));
      req.on('information', info => { information.push(info); trace.push('information:' + info.statusCode); });
      req.on('error', error => resolve({ code: error.code, reason: error.reason }));
      req.on(event, (res, sock, head) => {
        const output = { status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers,
          rawHeaders: res.rawHeaders, version: res.httpVersion, information, trace, body: '' };
        trace.push(event);
        if (event !== 'response') {
          output.head = head.toString('hex'); output.upgrade = res.upgrade;
          output.upgradeOrConnect = req.upgradeOrConnect; sock.destroy(); resolve(output); return;
        }
        res.on('error', reject);
        res.on('data', bytes => { output.body += bytes.toString('hex'); });
        res.on('end', () => { output.complete = res.complete; resolve(output); });
      });
      req.end();
    });
  } finally {
    clearTimeout(timer); req?.destroy(); for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
const cases = {
  async informationalBeforeFinalResponse() {
    const wire = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n' +
      'HTTP/1.1 200 \r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
    assert.deepStrictEqual(await exchange(subject.http, wire), await exchange(http, wire));
  },
  async headResponseHasNoBody() {
    const wire = 'HTTP/1.1 200 OK\r\nContent-Length: 123\r\nConnection: close\r\n\r\n';
    assert.deepStrictEqual(await exchange(subject.http, wire, { method: 'HEAD' }), await exchange(http, wire, { method: 'HEAD' }));
  },
  async upgradeAndConnectTransferHead() {
    for (const method of ['GET', 'CONNECT']) {
      const wire = method === 'GET' ?
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n\x00\xffhead' :
        'HTTP/1.1 200 Connection established\r\n\r\n\x00\xfftunnel';
      const event = method === 'CONNECT' ? 'connect' : 'upgrade';
      assert.deepStrictEqual(await exchange(subject.http, wire, { method }, event), await exchange(http, wire, { method }, event));
    }
  },
  async malformedFramingAndHeaderLimits() {
    for (const [wire, options] of [
      ['HTTP/1.1 200 OK\r\nContent-Length: 1x\r\n\r\nx', {}],
      ['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx', {}],
      ['HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n', {}],
      ['HTTP/1.1 200 OK\r\nX: ' + 'a'.repeat(40) + '\r\n\r\n', { maxHeaderSize: 32 }],
      ['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX: \x01\r\nConnection: close\r\n\r\nx', { insecureHTTPParser: true }],
      ['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nX: \x7f\r\nConnection: close\r\n\r\nx', { httpValidation: 'relaxed' }],
    ]) assert.deepStrictEqual(await exchange(subject.http, wire, options), await exchange(http, wire, options));
  },
  parserOptionErrors() {
    const api = create(() => { throw new Error('Invalid options must not connect'); }).http;
    function error(api, options) {
      try {
        const req = api.request(options); req.on('error', () => {}); req.destroy();
      } catch (e) { return { name: e.name, code: e.code, message: e.message }; }
    }
    for (const options of [{ maxHeaderSize: -1 }, { maxHeaderSize: 1.5 }, { maxHeaderSize: '20' },
      { insecureHTTPParser: 1 }, { httpValidation: 'unknown' },
      { httpValidation: 'strict', insecureHTTPParser: false }, { joinDuplicateHeaders: 'true' }])
      assert.deepStrictEqual(error(api, options), error(http, options));
  },
  async headerCountIsAppliedBeforeIncomingHeaders() {
    async function run(api) {
      const peer = socket(); let sent = false;
      peer._write = (_bytes, _encoding, callback) => {
        callback(); if (!sent) {
          sent = true; queueMicrotask(() => peer.push(Buffer.from('HTTP/1.1 200 OK\r\nX-First: one\r\nX-Second: two\r\nContent-Length: 0\r\n\r\n')));
        }
      };
      let req;
      if (api === http) req = http.request({ createConnection: () => peer });
      else req = create(() => { queueMicrotask(() => peer.emit('connect')); return peer; }).http.request({});
      req.maxHeadersCount = 1; req.on('error', () => {}); req.end();
      const [res] = await once(req, 'response'); const out = { raw: res.rawHeaders, headers: res.headers };
      const ended = once(res, 'end'); res.resume(); await ended; peer.destroy(); req.destroy(); return out;
    }
    assert.deepStrictEqual(await run(subject.http), await run(http));
  },
  async unsolicitedResponseBytesAreNotReused() {
    let connections = 0;
    const peers = [];
    const api = create(() => {
      const index = ++connections, peer = socket(); peers.push(peer); let sent = false;
      peer._write = (_b, _e, cb) => {
        cb(); if (sent) return; sent = true;
        const response = index === 1 ?
          'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nattack' :
          'HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nreal';
        queueMicrotask(() => peer.push(Buffer.from(response)));
      };
      queueMicrotask(() => peer.emit('connect')); return peer;
    }).http;
    async function read() {
      const req = api.get('http://unsolicited.test/'); req.on('error', () => {});
      const [res] = await once(req, 'response'); let text = '';
      res.on('data', bytes => { text += bytes.toString(); }); await once(res, 'end');
      await new Promise(resolve => setImmediate(resolve)); return text;
    }
    try { assert.equal(await read(), ''); assert.equal(await read(), 'real'); assert.equal(connections, 2); }
    finally { for (const peer of peers) peer.destroy(); }
  },
  async pooledFailureDoesNotReplayPost() {
    let connections = 0, writes = 0;
    const peer = socket();
    peer._write = (_b, _e, cb) => {
      ++writes; cb();
      if (writes === 1) queueMicrotask(() => peer.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')));
      else queueMicrotask(() => peer.destroy());
    };
    const api = create(() => { ++connections; queueMicrotask(() => peer.emit('connect')); return peer; }).http;
    const first = api.get('http://pool.test/'); first.on('error', () => {});
    const [res] = await once(first, 'response'); const ended = once(res, 'end'); res.resume(); await ended;
    await new Promise(resolve => setImmediate(resolve));
    const second = api.request({ hostname: 'pool.test', method: 'POST', headers: { 'Content-Length': '0' } });
    const error = once(second, 'error'); second.end(); const [failure] = await error;
    assert.equal(failure.code, 'ECONNRESET'); assert.equal(connections, 1); assert.equal(writes, 2);
    peer.destroy();
  },
  constructorAndDescriptors() {
    const C = subject.incoming.IncomingMessage;
    assert.equal(subject.builtinIncoming.IncomingMessage, C);
    assert.equal(subject.http.IncomingMessage, C);
    assert.deepStrictEqual(descriptors(C), descriptors(http.IncomingMessage));
    const peer = socket();
    const a = new C(peer), b = new http.IncomingMessage(peer);
    assert.equal(Object.getPrototypeOf(C.prototype), stream.Readable.prototype);
    assert.equal(Object.getPrototypeOf(C), stream.Readable);
    for (const key of ['socket', 'client', 'connection', 'complete', 'aborted', 'upgrade', 'url', 'method',
      'statusCode', 'statusMessage', 'httpVersion', 'httpVersionMajor', 'httpVersionMinor', 'readableHighWaterMark']) {
      assert.deepStrictEqual(a[key], b[key], key);
    }
    a.connection = null; assert.equal(a.socket, null); peer.destroy();
  },
  headerAndTrailerState() {
    function run(C) {
      const out = [];
      for (const join of [false, true]) {
        const m = new C(); m.joinDuplicateHeaders = join;
        const raw = ['Authorization', 'a', 'AUTHORIZATION', 'b', 'Cookie', 'a=1', 'COOKIE', 'b=2',
          'Set-Cookie', 'one=1', 'set-cookie', 'two=2', '__proto__', 'literal', 'X-Other', 'a', 'X-Other', 'b'];
        m._addHeaderLines(raw, raw.length);
        out.push({ headers: m.headers, distinct: m.headersDistinct, raw: m.rawHeaders });
        m.complete = true; m._addHeaderLines(['X-Trailer', 'a', 'X-Trailer', 'b', '__proto__', 'trailer'], 6);
        out.push({ trailers: m.trailers, distinct: m.trailersDistinct, raw: m.rawTrailers });
        m.headers = { own: 'value' }; m._addHeaderLines(['Other', 'ignored'], 2);
        out.push(m.headers, m.trailers);
      }
      return out;
    }
    assert.deepStrictEqual(run(subject.incoming.IncomingMessage), run(http.IncomingMessage));
  },
  async readTimeoutAndAbort() {
    async function run(C) {
      const peer = socket(); const calls = [];
      peer.setTimeout = milliseconds => calls.push(['timeout', milliseconds]);
      peer.resume = () => calls.push(['resume']);
      const message = new C(peer); message.on('error', () => {});
      assert.equal(message.setTimeout(73), message); message._read();
      const signal = message.signal; let aborts = 0; signal.addEventListener('abort', () => aborts++);
      let aborted = 0; message.on('aborted', () => aborted++);
      const closed = once(message, 'close'); message.destroy(); await closed;
      return { calls, aborted, aborts, signal: signal.aborted, peer: peer.destroyed };
    }
    assert.deepStrictEqual(await run(subject.incoming.IncomingMessage), await run(http.IncomingMessage));
  },
  async fragmentedWireHeadersAndTrailers() {
    const fragments = ['HTTP/1.1 200 OK\r\nContent-Type: one\r\nContent-Type: two\r\nCookie: a=1\r\n',
      'Cookie: b=2\r\nSet-Cookie: one=1\r\nSet-Cookie: two=2\r\n__proto__: literal\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
      '2\r\na', 'b\r\n1\r\nc\r\n0\r\nX-Trailer: one\r\n', 'X-Trailer: two\r\n__proto__: trail\r\n\r\n'];
    for (const joinDuplicateHeaders of [false, true]) {
      assert.deepStrictEqual(await receive(subject.http, fragments, { joinDuplicateHeaders }),
        await receive(http, fragments, { joinDuplicateHeaders }));
    }
  },
  async parserCompletionRetainsUnreadResponse() {
    // Actual client/parser with an explicit native transport boundary. The
    // parser receiving EOF is distinct from consumer end and request finish.
    const peer = socket(); let sent = false;
    peer._write = (_bytes, _encoding, callback) => {
      callback();
      if (!sent) { sent = true; queueMicrotask(() => peer.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'))); }
    };
    const api = create(() => { queueMicrotask(() => peer.emit('connect')); return peer; }).http;
    const req = api.get('http://unread.test/'); req.on('error', () => {});
    const [res] = await once(req, 'response');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.complete, true); assert.equal(res.readableEnded, false);
    assert.equal(req._socket, peer); assert.equal(peer._poolTimer, undefined);
    const signal = res.signal; const ended = once(res, 'end'); res.resume(); await ended;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(req._socket, null); assert.equal(res.socket, null);
    peer.destroy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false); req.destroy();
  },
  async earlyResponseRetainsPendingWrite() {
    // The complete pinned outgoing owner can coalesce header/body into one
    // real write. Exercise the finish fence with an actually paused TCP peer,
    // not the former assumption of separate fake header/body callbacks.
    await require('./node-http-request-framing-controls.cjs').earlyResponseRetainsRealPendingWrite();
  },
};
module.exports = { cases };
if (require.main === module) {
  const name = process.argv[2]; assert.equal(typeof cases[name], 'function');
  Promise.resolve().then(() => cases[name]()).then(() => console.log(JSON.stringify({ case: name, passed: true,
    scope: 'Actual candidate IncomingMessage/parser/client over explicit native stream/abort/URL/loopback boundaries; not guest/four-host conformance' })))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
