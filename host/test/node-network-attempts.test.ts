import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { createDnsPlatform } = createRequire(import.meta.url)('./fixtures/node-dns-platform.cjs');
const addressRulesPlatform = createRequire(import.meta.url)('./fixtures/node-address-rules-platform.cjs');
const dnsCleanups: Array<() => void> = [];
import * as native from 'node:net';
import * as dns from 'node:dns';
import * as nativeDiagnostics from 'node:diagnostics_channel';
import * as nativeStreams from 'node:stream';
import { addAbortListener } from 'node:events';
import { inspect, types } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticsPlatform } from './fixtures/node-diagnostics-platform';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing network source boundary');
  return source.slice(a, b);
}
// Extract the actual DNS and Socket/Server owners. The shared stream factory
// and engine transport are explicit boundaries here; this cannot establish
// Kandelo stream integration or guest POSIX/network conformance.
function subject(boundary: any) {
  const diagnostics = createDiagnosticsPlatform();
  const dnsContext = createDnsPlatform();
  dnsCleanups.push(dnsContext.close);
  return Function('_nodeNative', 'Buffer', 'util', '_nodeDiagnostics', '_nodeStreamPlatform', '_nodeValues', '_nodeEventPlatform', '_nodeDispose',
    '_createNodeNetworkIP', '_createNodeDnsLookupPlatform', '_createNodePerformanceObserverPlatform',
    '_nodeAsyncPlatform', '_nodeWebPlatform', 'process', 'timers', '_createNodeAddressRules', '_nodeClonePlatform', '_nodeInspection',
    section('function _errnoToCode(', 'function _checkErrno(') +
    section('const events =', '// events.setMaxListeners') +
    section('const stream =', 'const _nodePortIO =') +
    section('const _nodeNetworkIP =', '// tls module') +
    ';return {net,dns:_nodeDnsLookup,begin:_nodeBeginSocketConnection,diagnostics:_nodeDiagnostics.api};')
    ({ ...addressRulesPlatform.native, ...dnsContext.native, ...boundary }, Buffer, { inspect }, diagnostics, { api: nativeStreams }, dnsContext.values,
      { ...dnsContext.event, addAbortListener }, Symbol.dispose, dnsContext.factories.ip, dnsContext.factories.dns, dnsContext.factories.perf,
      { api: { asyncWrapProviders: dnsContext.asyncProviders } }, dnsContext.web, process,
      { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate },
      addressRulesPlatform.factories.address, addressRulesPlatform.clone, { inspect });
}
function deferred<T = number>() {
  let resolve!: (value: T) => void, reject!: (reason: any) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function controlled() {
  const attempts: any[] = [], closed: number[] = [], cancelled: Promise<number>[] = [];
  const api = subject({
    isNativeError: types.isNativeError,
    socketConnect(...args: any[]) { const d = deferred(); attempts.push({ ...d, args }); return d.promise; },
    socketCancelConnect(p: Promise<number>) { cancelled.push(p); },
    socketClose(fd: number) { closed.push(fd); },
    socketAddress() { return { address: '::1', family: 'IPv6', port: 123 }; },
    socketRead() { return new Promise(() => {}); },
  });
  return { ...api, attempts, closed, cancelled };
}
const records = [
  { address: '::1', family: 6 }, { address: '::1', family: 6 },
  { address: '::2', family: 6 }, { address: '127.0.0.1', family: 4 },
  { address: 'bad', family: 4 }, { address: '127.0.0.2', family: 4 },
];
const lookup = (_host: string, _options: any, cb: Function) => cb(null, records);
describe.skipIf(process.versions.node !== target.version)('live TCP BlockList consumers', () => {
  it('validates constructor options and keeps the actual supplied rule owner', () => {
    const s = controlled();
    for (const name of ['BlockList', 'SocketAddress'] as const) {
      const actual = Object.getOwnPropertyDescriptor(s.net, name)!;
      // ESM namespaces reify bindings as data properties. This compares
      // the actual CommonJS module object that the bootstrap implements.
      const expected = Object.getOwnPropertyDescriptor(createRequire(import.meta.url)('node:net'), name)!;
      expect([actual.enumerable, actual.configurable, actual.set, actual.get?.name, actual.get?.length])
        .toEqual([expected.enumerable, expected.configurable, expected.set, expected.get?.name, expected.get?.length]);
      Reflect.get(s.net, name);
      expect(Object.getOwnPropertyDescriptor(s.net, name)?.get).toBe(actual.get);
    }
    for (const value of [1, true, {}, []]) {
      for (const name of ['Socket', 'Server'] as const) {
        expect(outcome(() => new s.net[name]({ blockList: value }))).toEqual(
          outcome(() => new (native[name] as any)({ blockList: value })));
      }
    }
    const list = new s.net.BlockList();
    const socket = new s.net.Socket({ blockList: list });
    const server = new s.net.Server({ blockList: list });
    expect(socket.blockList).toBe(list); expect(server.blockList).toBe(list);
    expect(s.net.Stream).toBe(s.net.Socket); socket.destroy();
  });

  it('uses live rules after the single-address attempt event and never opens a blocked transport', async () => {
    const s = controlled(), list = new s.net.BlockList();
    const socket = new s.net.Socket({ blockList: list });
    socket.on('connectionAttempt', (address: string) => list.addAddress(address));
    const failed = new Promise<any>(resolve => socket.once('error', resolve));
    socket.connect({ host: '127.0.0.1', port: 123 });
    expect((await failed).code).toBe('ERR_IP_BLOCKED');
    expect(s.attempts).toHaveLength(0); expect(socket.destroyed).toBe(true);
  });

  it('skips blocked family candidates before transport and retains their real failure', async () => {
    const s = controlled(), list = new s.net.BlockList(), seen: any[] = [];
    list.addAddress('::1', 'ipv6');
    const operation = s.begin({ port: 123, host: 'controlled.test', blockList: list,
      lookup: (_h: string, _o: any, cb: Function) => cb(null, [
        { address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 },
      ]) }, (event: string, ...args: any[]) => seen.push([event, ...args]));
    const rejected = operation.promise.catch((error: any) => error);
    operation.start();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0].args.slice(0, 3)).toEqual(['127.0.0.1', 123, 4]);
    expect(seen.filter(row => row[0] === 'connectionAttempt').map(row => row[1])).toEqual(['127.0.0.1']);
    expect(seen.find(row => row[0] === 'connectionAttemptFailed')[4].code).toBe('ERR_IP_BLOCKED');
    s.attempts[0].reject({ code: 'ECONNREFUSED', errno: -111 });
    const error = await rejected;
    expect(error.errors.map((item: any) => item.code)).toEqual(['ERR_IP_BLOCKED', 'ECONNREFUSED']);
  });

  it('filters actual accepted peers, closes blocked fds and observes later rule removal', async () => {
    const accepts: ReturnType<typeof deferred>[] = [], closed: number[] = [];
    const s = subject({ isNativeError: types.isNativeError,
      socketListen() { return 7; }, socketAccept() { const item = deferred(); accepts.push(item); return item.promise; },
      socketClose(fd: number) { closed.push(fd); },
      socketAddress() { return { address: '127.0.0.1', family: 'IPv4', port: 123 }; },
      socketRead() { return new Promise(() => {}); },
    });
    const list = new s.net.BlockList(), accepted: any[] = [], drops: any[] = [];
    list.addAddress('127.0.0.1');
    const server = s.net.createServer({ blockList: list, pauseOnConnect: true }, (socket: any) => accepted.push(socket));
    server.on('drop', (...args: any[]) => drops.push(args));
    await new Promise<void>(resolve => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    accepts[0].resolve(11); await new Promise(resolve => setImmediate(resolve));
    expect(closed).toEqual([11]); expect(accepted).toHaveLength(0); expect(drops).toHaveLength(0);
    list.removeAddress('127.0.0.1');
    accepts[1].resolve(12); await new Promise(resolve => setImmediate(resolve));
    expect(accepted).toHaveLength(1); expect(accepted[0].remoteAddress).toBe('127.0.0.1');
    accepted[0].destroy(); await new Promise(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => server.close(resolve));
    expect(closed).toEqual([11, 12, 7]);
  });
});
function outcome(fn: () => unknown) {
  try { return { value: fn() }; } catch (error: any) { return { name: error.name, code: error.code }; }
}
afterEach(() => { for (const close of dnsCleanups.splice(0)) close(); vi.useRealTimers(); });

describe.skipIf(process.versions.node !== target.version)('TCP diagnostic producer controls', () => {
  it('publishes attempted clients before callback registration and option rejection', () => {
    function run(api: any, diagnostics: any) {
      const socket = new api.Socket(), events: unknown[] = [];
      const observer = (message: any) => events.push([Object.keys(message), message.socket === socket,
        message.socket.connecting, socket.listenerCount('connect')]);
      diagnostics.subscribe('net.client.socket', observer);
      try {
        expect(() => socket.connect({ port: -1 }, () => {})).toThrow();
      } finally { diagnostics.unsubscribe('net.client.socket', observer); socket.destroy(); }
      return events;
    }
    const s = controlled();
    expect(run(s.net, s.diagnostics)).toEqual(run(native, nativeDiagnostics));
  });

  it('publishes adopted server sockets after the public connection handler', async () => {
    const accept = deferred();
    let accepted = false;
    const s = subject({
      isNativeError: types.isNativeError,
      socketListen() { return 7; },
      socketAccept() { if (!accepted) { accepted = true; return accept.promise; } return new Promise(() => {}); },
      socketAddress() { return { address: '127.0.0.1', family: 'IPv4', port: 123 }; },
      socketClose() {}, socketRead() { return new Promise(() => {}); },
    });
    async function run(api: any, diagnostics: any, drive?: () => void) {
      const server = api.createServer({ pauseOnConnect: true }), events: unknown[] = [];
      let peer: any, adopted: any;
      let resolve!: () => void;
      const publication = new Promise<void>(r => { resolve = r; });
      const observer = (message: any) => {
        if (message.socket.server !== server) return;
        events.push(['publication', Object.keys(message), message.socket === adopted,
          message.socket instanceof api.Socket, message.socket.destroyed]);
        resolve();
      };
      diagnostics.subscribe('net.server.socket', observer);
      server.on('connection', (socket: any) => {
        adopted = socket;
        events.push(['connection', socket.server === server]);
        socket.destroy();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
        });
        if (drive) drive(); else peer = native.connect(server.address().port, '127.0.0.1');
        await publication;
        return events;
      } finally {
        diagnostics.unsubscribe('net.server.socket', observer);
        peer?.destroy(); adopted?.destroy();
        await new Promise<void>(resolve => server.close(resolve));
      }
    }
    expect(await run(s.net, s.diagnostics, () => accept.resolve(8)))
      .toEqual(await run(native, nativeDiagnostics));
  });
});

describe('shared TCP connection policy', () => {
  it('alternates deduplicated families and preserves real errors in the aggregate', async () => {
    const s = controlled(), events: any[] = [];
    const operation = s.begin({ host: 'addresses.test', port: 123, lookup }, (...args: any[]) => events.push(args));
    const result = operation.promise.catch((error: any) => error);
    operation.start();
    for (let i = 0; i < 4; i++) {
      expect(s.attempts).toHaveLength(i + 1);
      s.attempts[i].reject({ errno: -111, syscall: 'connect' });
      await Promise.resolve();
    }
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.code).toBe('ECONNREFUSED');
    expect(error.errors.map((e: any) => [e.address, e.code, e.port, e.errno])).toEqual(
      ['::1', '127.0.0.1', '::2', '127.0.0.2'].map(a => [a, 'ECONNREFUSED', 123, -111]));
    expect(events.filter(e => e[0] === 'lookup')).toHaveLength(records.length);
    expect(events.filter(e => e[0] === 'connectionAttemptFailed')).toHaveLength(4);
  });

  it('uses the snapshotted default deadline, cancels timed out attempts and closes late successes', async () => {
    vi.useFakeTimers();
    const s = controlled(), events: string[] = [];
    s.net.setDefaultAutoSelectFamilyAttemptTimeout(20);
    let resolved!: Function;
    const operation = s.begin({ host: 'addresses.test', port: 123, lookup(_h: string, _o: any, cb: Function) { resolved = cb; } },
      (event: string) => events.push(event));
    operation.start();
    s.net.setDefaultAutoSelectFamilyAttemptTimeout(500);
    resolved(null, records.slice(0, 1).concat(records.slice(3, 4)));
    await vi.advanceTimersByTimeAsync(19);
    expect(s.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.attempts).toHaveLength(2);
    expect(s.cancelled).toEqual([s.attempts[0].promise]);
    expect(events.filter(e => e === 'connectionAttemptTimeout')).toHaveLength(1);
    // The last destination is not governed by the family-fallback deadline.
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.cancelled).toHaveLength(1);
    s.attempts[0].resolve(41);
    s.attempts[1].resolve(42);
    expect(await operation.promise).toMatchObject({ fd: 42, family: 4 });
    expect(s.closed).toEqual([41]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not apply a fallback deadline or custom lookup to a literal address', async () => {
    vi.useFakeTimers();
    const s = controlled(), called = vi.fn();
    const op = s.begin({ host: '::1', port: 123, lookup: called, autoSelectFamilyAttemptTimeout: 10 });
    op.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(called).not.toHaveBeenCalled();
    expect(s.attempts).toHaveLength(1);
    expect(s.cancelled).toHaveLength(0);
    s.attempts[0].resolve(5);
    await op.promise;
  });

  it('aborts lookup and pending connections, removing listeners and rejecting once', async () => {
    for (const pending of [false, true]) {
      const s = controlled(), signal = new AbortController(), reason = Error('stop');
      const remove = vi.spyOn(signal.signal, 'removeEventListener');
      let cb!: Function;
      const op = s.begin({ host: 'addresses.test', port: 123, signal: signal.signal,
        lookup(_h: string, _o: any, callback: Function) { cb = callback; } });
      const result = op.promise.catch((error: any) => error);
      op.start();
      if (pending) cb(null, records);
      signal.abort(reason);
      const error = await result;
      expect([error.name, error.code, error.cause]).toEqual(['AbortError', 'ABORT_ERR', reason]);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      if (pending) {
        expect(s.cancelled).toEqual([s.attempts[0].promise]);
        s.attempts[0].resolve(7);
        await Promise.resolve();
        expect(s.closed).toEqual([7]);
      } else { cb(null, records); expect(s.attempts).toHaveLength(0); }
    }
  });

  it('snapshots disabled family selection and forwards a single lookup result', async () => {
    const s = controlled();
    let finish!: Function, received: any;
    s.net.setDefaultAutoSelectFamily(false);
    const op = s.begin({ host: 'addresses.test', port: 123, lookup(_h: string, options: any, callback: Function) {
      received = options; finish = callback;
    } });
    s.net.setDefaultAutoSelectFamily(true);
    op.start();
    expect(received.all).toBeUndefined();
    finish(null, '::1', 6);
    expect(s.attempts[0].args.slice(0, 3)).toEqual(['::1', 123, 6]);
    s.attempts[0].resolve(4);
    await op.promise;
  });

  it('ignores falsy local bind options consistently with connection validation', async () => {
    const s = controlled();
    const op = s.begin({host:'::1',port:123,localAddress:false,localPort:null});
    op.start();
    await Promise.resolve();
    expect(s.attempts[0].args).toEqual(['::1',123,6,undefined,undefined]);
    s.attempts[0].resolve(4);
    await op.promise;
  });

  it('stops when a connection-attempt listener destroys the public socket', async () => {
    const s = controlled(), socket = new s.net.Socket();
    const close = new Promise(resolve => socket.once('close', resolve));
    socket.on('connectionAttempt', () => socket.destroy());
    socket.connect({ host: 'addresses.test', port: 123, lookup });
    await close;
    expect(socket.connecting).toBe(false);
    expect(s.attempts).toHaveLength(0);
  });
});

// This bridge creates actual host sockets and does not choose addresses or
// deadlines. It is evidence for the shared JS policy, not the guest libc.
function realBoundary() {
  let serial = 0;
  const sockets = new Map<number, native.Socket>();
  const pending = new Map<Promise<number>, { socket: native.Socket; reject: Function }>();
  const bridge = {
    isNativeError: types.isNativeError,
    socketLookup(host: string, family: number, _hints: number) {
      return dns.promises.lookup(host, { family, all: true });
    },
    socketConnect(host: string, port: number, family: number, localAddress?: string, localPort?: number) {
      const d = deferred(), socket = new native.Socket();
      pending.set(d.promise, { socket, reject: d.reject });
      socket.once('error', error => { pending.delete(d.promise); socket.destroy(); d.reject(error); });
      socket.once('connect', () => { pending.delete(d.promise); const fd = ++serial; sockets.set(fd, socket); d.resolve(fd); });
      socket.connect({ host, port, family, localAddress, localPort });
      return d.promise;
    },
    socketCancelConnect(p: Promise<number>) { const op = pending.get(p); if (op) { pending.delete(p); op.socket.destroy(); op.reject({ errno: -125 }); } },
    socketAddress(fd: number, peer = false) {
      const s = sockets.get(fd)!;
      return peer ? { address: s.remoteAddress, family: s.remoteFamily, port: s.remotePort } : s.address();
    },
    socketRead(fd: number) {
      const socket = sockets.get(fd)!;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        function cleanup() { socket.off('readable', read); socket.off('end', end); socket.off('error', error); }
        function end() { cleanup(); resolve(new ArrayBuffer(0)); }
        function error(e: Error) { cleanup(); reject(e); }
        function read() { const chunk = socket.read(); if (chunk !== null) { cleanup(); resolve(Uint8Array.from(chunk).buffer); } }
        socket.on('readable', read); socket.once('end', end); socket.once('error', error); read();
      });
    },
    socketWrite(fd: number, data: Uint8Array) {
      return new Promise<void>((resolve, reject) => sockets.get(fd)!.write(data, error => error ? reject(error) : resolve()));
    },
    socketWriteQueueSize(fd: number) { return sockets.get(fd)?.bufferSize ?? 0; },
    socketClose(fd: number) { sockets.get(fd)?.destroy(); sockets.delete(fd); },
  };
  return { bridge, sockets, pending };
}

describe.skipIf(process.versions.node !== target.version)('network policy against pinned Node', () => {
  it('matches default values and setter validation, including the 10ms minimum', () => {
    const s = controlled().net;
    const initial = [native.getDefaultAutoSelectFamily(), native.getDefaultAutoSelectFamilyAttemptTimeout()];
    expect([s.getDefaultAutoSelectFamily(), s.getDefaultAutoSelectFamilyAttemptTimeout()]).toEqual(initial);
    try {
      for (const value of [undefined, null, false, true, -1, 0, 1, 9, 10, 500, 1.5, NaN, Infinity, 2 ** 31 - 1, 2 ** 31, '10', {}, new Number(10), Symbol('v')]) {
        for (const api of [s, native]) { api.setDefaultAutoSelectFamily(true); api.setDefaultAutoSelectFamilyAttemptTimeout(500); }
        expect(outcome(() => { s.setDefaultAutoSelectFamily(value); return s.getDefaultAutoSelectFamily(); }))
          .toEqual(outcome(() => { native.setDefaultAutoSelectFamily(value as any); return native.getDefaultAutoSelectFamily(); }));
        expect(outcome(() => { s.setDefaultAutoSelectFamilyAttemptTimeout(value); return s.getDefaultAutoSelectFamilyAttemptTimeout(); }))
          .toEqual(outcome(() => { native.setDefaultAutoSelectFamilyAttemptTimeout(value as any); return native.getDefaultAutoSelectFamilyAttemptTimeout(); }));
      }
    } finally { native.setDefaultAutoSelectFamily(initial[0] as boolean); native.setDefaultAutoSelectFamilyAttemptTimeout(initial[1] as number); }
  });

  it('matches the pinned IP grammar including mapped IPv4, zone IDs and coercion', () => {
    const s = controlled().net;
    for (const address of ['127.0.0.1', '01.0.0.1', '256.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fe80::1%eth0',
      '2001:db8:1:2:3:4:5:6', '2001:db8::1', '1::2::3', 'localhost', '', null, undefined, 42, [], {}, { toString: () => '::1' }, Symbol('ip')]) {
      for (const method of ['isIP', 'isIPv4', 'isIPv6'] as const) expect(outcome(() => s[method](address)), method + String(address))
        .toEqual(outcome(() => native[method](address as any)));
    }
  });

  it('matches errors from invalid custom lookup addresses and families', async () => {
    async function run(api: any, all: boolean, record: any) {
      const socket = new api.Socket();
      try {
        return await new Promise(resolve => {
          socket.once('error', (error: any) => resolve({name:error.name,code:error.code}));
          socket.connect({host:'records.test',port:123,autoSelectFamily:all,
            lookup(_host: string, _options: any, callback: Function) {
              if (all) callback(null,[record]);
              else callback(null,record.address,record.family);
            }});
        });
      } finally { socket.destroy(); }
    }
    for (const all of [false,true]) for (const record of [
      {address:'bad',family:4}, {address:'::1',family:7}, {address:42,family:6},
    ]) expect(await run(controlled().net,all,record),inspect([all,record]))
      .toEqual(await run(native,all,record));
  });

  it('matches public DNS literal, option validation and callback scheduling', async () => {
    const api = subject(realBoundary().bridge).dns;
    async function run(dnsApi: any, hostname: any, options: any) {
      let synchronous = true;
      const result = new Promise(resolve => {
        try { dnsApi.lookup(hostname, options, (error: any, address: any, family: any) => {
          resolve(error ? { name:error.name, code:error.code, synchronous } : {address,family,synchronous});
        }); } catch (error: any) { resolve({name:error.name,code:error.code,synchronous}); }
      });
      synchronous = false;
      return result;
    }
    for (const hostname of ['127.0.0.1', '::1', '', null, undefined, false, 0, 42, {}]) {
      for (const options of [undefined, null, 0, 4, 6, {all:true}, {family:'IPv4'}, {family:7},
        {all:1}, {verbatim:'yes'}, {order:'bad'}, {hints:'0'}]) {
        expect(await run(api,hostname,options), inspect([hostname,options]))
          .toEqual(await run(dns,hostname,options));
      }
    }
  });

  it('connects real IPv6 loopback after an IPv4 failure and exchanges queued bytes', async () => {
    const server = native.createServer(socket => socket.on('data', data => socket.end(data)));
    const accepted = new Set<native.Socket>();
    server.on('connection', socket => { accepted.add(socket); socket.on('close', () => accepted.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
    const port = (server.address() as native.AddressInfo).port;
    const boundary = realBoundary(), s = subject(boundary.bridge), socket = new s.net.Socket();
    try {
      const attempts: any[] = [];
      socket.on('connectionAttempt', (...args: any[]) => attempts.push(args));
      const body = new Promise<string>((resolve, reject) => { let text = ''; socket.on('data', (b: Buffer) => { text += b.toString(); }); socket.once('end', () => resolve(text)); socket.once('error', reject); });
      const connected = new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.connect({ host: 'addresses.test', port, lookup: (_h: string, _o: any, cb: Function) => cb(null,
        [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]) });
      socket.write('actual TCP bytes');
      await connected;
      expect(await body).toBe('actual TCP bytes');
      expect(attempts).toEqual([['127.0.0.1', port, 4], ['::1', port, 6]]);
      expect(socket.autoSelectFamilyAttemptedAddresses).toEqual(['127.0.0.1:' + port, '::1:' + port]);
      expect([socket.remoteAddress, socket.remoteFamily, socket.remotePort]).toEqual(['::1', 'IPv6', port]);
      expect(socket.localAddress).toBe('::1');
      expect(socket.localPort).toBeGreaterThan(0);
      expect(boundary.pending.size).toBe(0);
    } finally {
      socket.destroy();
      for (const s of accepted) s.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(boundary.sockets.size).toBe(0);
  });
});
