import { Buffer as NativeBuffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as stream from 'node:stream';
import * as http from 'node:http';
import * as net from 'node:net';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const factories = Function(`${bundle};return { headers:_createNodeHttpHeaders, incoming:_createNodeHttpIncoming, values:_createNodeValuesPlatform,
  bytes:_installNodeBufferBytes, codecs:_installNodeBufferCodecs, unpooled:_installNodeBufferUnpooled,
  parser:_createNodeHttpParser };`)();
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing HTTP source boundary'); return source.slice(a, b);
}
const require = createRequire(import.meta.url);
function subject(live = false) {
  const { Buffer, values } = require('./fixtures/node-buffer-pool.cjs').create();
  values.require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
  const outgoing = require('./fixtures/node-http-outgoing-platform.cjs').create(Buffer, values);
  const headers = factories.headers({ Buffer, values, outgoing, insecureHTTPParser: false });
  const incoming = factories.incoming({ stream, abort: { AbortController }, process });
  const pending: Array<() => void> = [];
  // Actual request/parser/header/Buffer source. Native streams and URL are
  // explicit boundaries; only live controls use real native loopback sockets.
  const make = Function('_nodeHttpHeaders', '_nodeHttpIncoming', 'Buffer', 'stream', 'url', 'queueMicrotask', '_nodeValues', '_createNodeHttpParser', '_nodeNative', '_nodeHttpOutgoing',
    'const STATUS_CODES=_nodeHttpHeaders.STATUS_CODES;' +
    section('const HTTP_METHODS =', 'const http = makeHttpModule(') + ';return makeHttpModule;')
    (headers, incoming, Buffer, stream, url, live ? queueMicrotask : (fn: () => void) => pending.push(fn), values,
      factories.parser, require('./fixtures/node-http-incoming-platform.cjs').nativeParserBoundary(), outgoing);
  return { api: make({ defaultPort: 80, defaultProtocol: 'http:',
    connect: (options: net.NetConnectOpts) => net.connect(options) }), headers, Buffer, pending };
}
function failure(fn: () => unknown) {
  try { fn(); return undefined; } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; }
}
function nativeRequest(options: any) {
  const socket = new stream.Duplex({ read() {}, write(_chunk, _encoding, cb) { cb(); } });
  (socket as any).connecting = true;
  const request = http.request({ host: 'headers.test', createConnection: () => socket as any, ...options });
  request.on('error', () => {}); return request;
}

describe.skipIf(process.versions.node !== target.version)('pinned outgoing HTTP header owners', () => {
  it('matches token/value public validation and complete status-code constants', () => {
    const { api } = subject();
    expect(api.STATUS_CODES).toEqual(http.STATUS_CODES);
    for (const name of ['', 'X-Valid_!~', 'long-valid-header-name', 'bad name', 'é', null, undefined, 4, {}, Symbol('h')]) {
      expect(failure(() => api.validateHeaderName(name))).toEqual(failure(() => http.validateHeaderName(name as any)));
      expect(api.isValidHeaderName(name)).toBe(http.isValidHeaderName(name));
    }
    for (const value of [undefined, null, 0, NaN, '', 'é', '\tallowed', 'bad\r\nx: injected', '\x00', '\x01', '\x7f', '€', ['a', 'b'], Symbol('v')]) {
      expect(failure(() => api.validateHeaderValue('x', value))).toEqual(failure(() => http.validateHeaderValue('x', value as any)));
      for (const option of [undefined, { httpValidation: 'strict' }, { httpValidation: 'relaxed' }, { httpValidation: 'insecure' }, null]) {
        let actual: unknown, expected: unknown;
        const a = failure(() => { actual = api.isValidHeaderValue(value, option); });
        const b = failure(() => { expected = http.isValidHeaderValue(value as any, option as any); });
        expect([a, actual]).toEqual([b, expected]);
      }
    }
  });

  it('retains typed values, shallow arrays, original casing and append/set/remove behavior', () => {
    function run(request: any) {
      const values = ['one', 'two'];
      expect(request.setHeader('X-Test', values)).toBe(request);
      expect(request.getHeader('x-test')).toBe(values);
      request.appendHeader('x-test', 'three'); request.setHeader('X-Number', 4);
      request.setHeaders(new Map([['Other', 'value'], ['set-cookie', ['a=1', 'b=2']]]));
      const shallow = request.getHeaders(); expect(shallow['x-test']).toBe(values);
      const result = [Object.getPrototypeOf(shallow), shallow, request.getHeaderNames(), request.getRawHeaderNames(), request.hasHeader('X-Test')];
      request.removeHeader('other'); result.push(request.hasHeader('other'), request.getHeader('missing'));
      return result;
    }
    const candidate = subject().api.request({ headers: { Host: 'headers.test', Connection: 'close' } });
    const control = nativeRequest({ headers: { Host: 'headers.test', Connection: 'close' } });
    try { expect(run(candidate)).toEqual(run(control)); } finally { candidate.destroy(); control.destroy(); }
  });

  it('matches method/path and outgoing validation options before network acquisition', () => {
    const s = subject();
    for (const options of [{ method: 'BAD METHOD' }, { method: 1 }, { path: '/bad\r\nx: injected' },
      { httpValidation: 'bad' }, { insecureHTTPParser: 1 }, { httpValidation: 'strict', insecureHTTPParser: false },
      { headers: { 'bad name': 'value' } }, { headers: { x: undefined } }, { headers: { x: 'bad\nvalue' } }]) {
      expect(failure(() => s.api.request(options))).toEqual(failure(() => nativeRequest(options)));
    }
    expect(s.pending).toHaveLength(0);
  });

  it('freezes actual compiled header state when flushing before connection', () => {
    const s = subject(), candidate = s.api.request({ headers: { Host: 'headers.test', Connection: 'close' } });
    const control = nativeRequest({ headers: { Host: 'headers.test', Connection: 'close' } });
    try {
      expect(candidate.headersSent).toBe(false); expect(control.headersSent).toBe(false);
      candidate.flushHeaders(); control.flushHeaders();
      expect(candidate.headersSent).toBe(true); expect(control.headersSent).toBe(true);
      for (const method of ['setHeader', 'appendHeader', 'removeHeader']) {
        expect(failure(() => candidate[method]('x', 'value'))).toEqual(failure(() => (control as any)[method]('x', 'value')));
      }
    } finally { candidate.destroy(); control.destroy(); }
  });

  it('encodes shared Buffer single-byte aliases as low bytes without UTF-8 substitution', () => {
    const { Buffer } = subject();
    for (const input of ['', 'aéÿ', '\u0100€', '\ud800\udfff', '😀']) {
      for (const encoding of ['latin1', 'binary', 'ascii', 'LATIN1', 'ASCII']) {
        expect([...Buffer.from(input, encoding)]).toEqual([...NativeBuffer.from(input, encoding as any)]);
      }
    }
    const expected = [...NativeBuffer.from('é😀', 'latin1')];
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const descriptors = [Object.getOwnPropertyDescriptor(typed, 'buffer')!,
      Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')!,
      Object.getOwnPropertyDescriptor(String.prototype, 'toLowerCase')!];
    let actual: number[];
    try {
      Object.defineProperty(typed, 'buffer', { configurable: true, get() { throw Error('public buffer getter'); } });
      String.prototype.charCodeAt = () => { throw Error('public charCodeAt'); };
      String.prototype.toLowerCase = () => { throw Error('public toLowerCase'); };
      actual = [...Buffer.from('é😀', 'LATIN1')];
    } finally {
      Object.defineProperty(typed, 'buffer', descriptors[0]);
      Object.defineProperty(String.prototype, 'charCodeAt', descriptors[1]);
      Object.defineProperty(String.prototype, 'toLowerCase', descriptors[2]);
    }
    expect(actual!).toEqual(expected);
  });

  it('emits exact duplicate/cookie/Latin-1 wire headers over real native loopback TCP', async () => {
    async function capture(api: any) {
      let wire!: NativeBuffer, complete!: () => void;
      const received = new Promise<void>(resolve => { complete = resolve; });
      const peers = new Set<net.Socket>();
      const server = net.createServer(socket => {
        peers.add(socket); let bytes = NativeBuffer.alloc(0);
        socket.on('data', part => {
          bytes = NativeBuffer.concat([bytes, part]);
          if (bytes.includes('\r\n\r\n')) {
            wire = bytes; complete(); socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
          }
        });
        socket.on('close', () => peers.delete(socket));
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = (server.address() as net.AddressInfo).port;
      const request = api.request({ hostname: '127.0.0.1', port, path: '/é',
        headers: { Host: 'wire.test', Connection: 'close', 'X-Value': ['é', 'two'], Cookie: ['a=1', 'b=2'], 'Set-Cookie': ['one=1', 'two=2'] } });
      const errors: unknown[] = []; request.on('error', (error: unknown) => errors.push(error));
      try { request.end(); await received; expect(errors).toEqual([]); return wire; }
      finally { request.destroy(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    expect(await capture(subject(true).api)).toEqual(await capture(http));
  });
});
