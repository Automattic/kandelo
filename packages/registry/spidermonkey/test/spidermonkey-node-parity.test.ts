import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import {
  deflateSync as hostDeflateSync,
  gzipSync as hostGzipSync,
} from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageBuild = join(__dirname, "../bin/node.wasm");
const nodeWasm =
  tryResolveBinary("programs/spidermonkey-node.wasm") ??
  (existsSync(packageBuild) ? packageBuild : null);
const npmDist = join(__dirname, "../../../../packages/registry/npm/dist");
const npmCli = join(npmDist, "bin/npm-cli.js");
const hasNpm = existsSync(npmCli);

let nodeModule: WebAssembly.Module | undefined;

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function runNodeScript(
  source: string,
  options: { enableTcpNetwork?: boolean; timeout?: number } = {},
) {
  return runCentralizedProgram({
    programPath: nodeWasm!,
    programModule: nodeModule,
    argv: ["node", "-e", source],
    enableTcpNetwork: options.enableTcpNetwork,
    timeout: options.timeout ?? 30_000,
  });
}

function runNodeScriptOnHostFs(
  source: string,
  options: { timeout?: number } = {},
) {
  return runCentralizedProgram({
    programPath: nodeWasm!,
    argv: ["node", "-e", source],
    io: new NodePlatformIO(),
    timeout: options.timeout ?? 30_000,
  });
}

async function tcpReachable(host: string, port: number, timeoutMs = 500) {
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
    sock.connect(port, host);
  });
}

async function pickWasmDialHost() {
  if (!nodeWasm) return null;
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "0.0.0.0", () => resolve()));
  const port = (probe.address() as net.AddressInfo).port;
  try {
    const candidates = ["127.0.0.2"];
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const address of ifs ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          candidates.push(address.address);
        }
      }
    }
    for (const candidate of candidates) {
      if (await tcpReachable(candidate, port)) return candidate;
    }
    return null;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

const wasmDialHost = await pickWasmDialHost();

describe.skipIf(!nodeWasm)("SpiderMonkey Node compatibility parity", () => {
  beforeAll(async () => {
    nodeModule = await WebAssembly.compile(loadWasm(nodeWasm!));
  }, 90_000);

  describe("crypto", () => {
    it.each<[string, string, string]>([
      ["sha1", "", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
      ["sha1", "abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
      ["sha256", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["sha256", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["sha512", "", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"],
      ["sha512", "abc", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"],
      ["md5", "", "d41d8cd98f00b204e9800998ecf8427e"],
      ["md5", "abc", "900150983cd24fb0d6963f7d28e17f72"],
    ])("%s hash of %j matches the canonical vector", async (algorithm, input, want) => {
      const result = await runNodeScript(`
        const crypto = require('crypto');
        process.stdout.write(crypto.createHash(${JSON.stringify(algorithm)})
          .update(${JSON.stringify(input)}).digest('hex'));
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(want);
    });

    it.each<[string, string]>([
      ["sha1", "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"],
      ["sha256", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
      ["sha512", "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"],
      ["md5", "750c783e6ab0b503eaa86e310a5db738"],
    ])("%s HMAC matches canonical vector", async (algorithm, want) => {
      const result = await runNodeScript(`
        const crypto = require('crypto');
        process.stdout.write(crypto.createHmac(${JSON.stringify(algorithm)}, 'Jefe')
          .update('what do ya want for nothing?').digest('hex'));
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(want);
    });

    it("handles Buffer input, chunked updates, digest encodings, and post-digest errors", async () => {
      const result = await runNodeScript(`
        const crypto = require('crypto');
        const fromBuffer = crypto.createHash('sha256').update(Buffer.from('abc')).digest();
        const chunked = crypto.createHash('sha256').update('a').update('b').update('c').digest('base64');
        const hmac = crypto.createHmac('sha256', Buffer.from('Jefe'))
          .update(Buffer.from('what do ya want for nothing?')).digest('hex');
        let threw = false;
        const h = crypto.createHash('sha256');
        h.update('abc');
        h.digest();
        try { h.update('more'); } catch (_) { threw = true; }
        process.stdout.write(JSON.stringify({
          fromBuffer: Buffer.isBuffer(fromBuffer) && fromBuffer.length,
          chunked,
          hmac,
          threw,
        }));
      `);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        fromBuffer: 32,
        chunked: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
        hmac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        threw: true,
      });
    });
  });

  describe("zlib", () => {
    it("round-trips gzip and deflate buffers", async () => {
      const result = await runNodeScript(`
        const zlib = require('zlib');
        const input = Buffer.from('the quick brown fox jumps over the lazy dog');
        const gzip = zlib.gunzipSync(zlib.gzipSync(input)).toString();
        const deflate = zlib.inflateSync(zlib.deflateSync(input)).toString();
        const gz = zlib.gzipSync(Buffer.from('hello'));
        process.stdout.write(JSON.stringify({
          gzip,
          deflate,
          magic: gz[0].toString(16) + ' ' + gz[1].toString(16),
          buffer: Buffer.isBuffer(gz),
        }));
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        gzip: "the quick brown fox jumps over the lazy dog",
        deflate: "the quick brown fox jumps over the lazy dog",
        magic: "1f 8b",
        buffer: true,
      });
    });

    it("inflates host-produced gzip and deflate payloads", async () => {
      const original = "interop check between host zlib and wasm libz";
      const gzipHex = hostGzipSync(Buffer.from(original)).toString("hex");
      const deflateHex = hostDeflateSync(Buffer.from(original)).toString("hex");
      const result = await runNodeScript(`
        const zlib = require('zlib');
        const gzip = zlib.gunzipSync(Buffer.from(${JSON.stringify(gzipHex)}, 'hex')).toString();
        const deflate = zlib.inflateSync(Buffer.from(${JSON.stringify(deflateHex)}, 'hex')).toString();
        process.stdout.write(gzip + '|' + deflate);
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${original}|${original}`);
    });

    it("streams gzip and gunzip over chunked payloads", async () => {
      const result = await runNodeScript(`
        const zlib = require('zlib');
        const buf = Buffer.alloc(8192);
        for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + (i >> 3)) & 0xff;
        const gz = zlib.createGzip();
        const gzOut = [];
        gz.on('data', (d) => gzOut.push(d));
        gz.on('end', () => {
          const gunzip = zlib.createGunzip();
          const roundOut = [];
          gunzip.on('data', (d) => roundOut.push(d));
          gunzip.on('end', () => {
            process.stdout.write(String(Buffer.compare(buf, Buffer.concat(roundOut))));
          });
          const payload = Buffer.concat(gzOut);
          for (let i = 0; i < payload.length; i += 113) gunzip.write(payload.slice(i, i + 113));
          gunzip.end();
        });
        for (let i = 0; i < buf.length; i += 333) gz.write(buf.slice(i, i + 333));
        gz.end();
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("0");
    });
  });

  describe("async_hooks", () => {
    it("validates hook callbacks and returns chainable hook controls", async () => {
      const result = await runNodeScript(`
        const assert = require('assert');
        const async_hooks = require('async_hooks');
        assert.throws(() => async_hooks.createHook({ init: 1 }), {
          code: 'ERR_ASYNC_CALLBACK',
          name: 'TypeError',
          message: 'hook.init must be a function',
        });
        const seen = [];
        const hook = async_hooks.createHook({
          init(id, type, triggerId) {
            if (type === 'Immediate') seen.push(['init', id > 1, triggerId]);
          },
          before(id) { seen.push(['before', id]); },
          after(id) { seen.push(['after', id]); },
          destroy(id) { seen.push(['destroy', id]); },
        });
        assert.strictEqual(hook.enable(), hook);
        assert.strictEqual(hook.disable(), hook);
        hook.enable();
        setImmediate(() => {
          setImmediate(() => {
            hook.disable();
            process.stdout.write(JSON.stringify({
              hasInit: seen.some((entry) => entry[0] === 'init' && entry[1] === true && entry[2] === 1),
              hasBefore: seen.some((entry) => entry[0] === 'before'),
              hasAfter: seen.some((entry) => entry[0] === 'after'),
            }));
          });
        });
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hasInit: true,
        hasBefore: true,
        hasAfter: true,
      });
    });

    it("tracks AsyncResource scope, bind metadata, and AsyncLocalStorage snapshots", async () => {
      const result = await runNodeScript(`
        const assert = require('assert');
        const { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId } = require('async_hooks');
        const als = new AsyncLocalStorage();
        const resource = new AsyncResource('test-resource');
        const bound = resource.bind(function(a, b) {
          assert.strictEqual(this.label, 'ctx');
          assert.strictEqual(executionAsyncId(), resource.asyncId());
          assert.strictEqual(triggerAsyncId(), 1);
          return [a, b, als.getStore()];
        }, { label: 'ctx' });
        assert.strictEqual(bound.asyncResource, resource);
        assert.strictEqual(bound.length, 2);
        const sync = als.run('outer', () => {
          const snapshot = AsyncLocalStorage.snapshot();
          return als.run('inner', () => snapshot(() => als.getStore()));
        });
        assert.strictEqual(sync, 'outer');
        als.run('timer-store', () => {
          setTimeout(() => {
            Promise.resolve('promise-store').then(() => {
              const boundResult = bound(1, 2);
              process.stdout.write(JSON.stringify({
                timerStore: als.getStore(),
                boundResult,
              }));
            });
          }, 0);
        });
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        timerStore: "timer-store",
        boundResult: [1, 2, null],
      });
    });

    it("exposes v8.promiseHooks for resolve and then lifecycle events", async () => {
      const result = await runNodeScript(`
        const assert = require('assert');
        const { promiseHooks } = require('v8');
        const seen = [];
        const stop = promiseHooks.createHook({
          init(promise, parent) { seen.push(['init', !!promise, parent === undefined ? 'root' : 'child']); },
          before(promise) { seen.push(['before', !!promise]); },
          after(promise) { seen.push(['after', !!promise]); },
          settled(promise) { seen.push(['settled', !!promise]); },
        });
        const parent = Promise.resolve(1);
        const child = parent.then((value) => value + 1);
        child.then((value) => {
          stop();
          assert.strictEqual(value, 2);
          process.stdout.write(JSON.stringify({
            rootInit: seen.some((entry) => entry[0] === 'init' && entry[2] === 'root'),
            childInit: seen.some((entry) => entry[0] === 'init' && entry[2] === 'child'),
            before: seen.some((entry) => entry[0] === 'before'),
            after: seen.some((entry) => entry[0] === 'after'),
            settled: seen.filter((entry) => entry[0] === 'settled').length >= 2,
          }));
        });
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        rootInit: true,
        childInit: true,
        before: true,
        after: true,
        settled: true,
      });
    });

    it("runs EventEmitterAsyncResource emits inside its async resource", async () => {
      const result = await runNodeScript(`
        const assert = require('assert');
        const { EventEmitterAsyncResource } = require('events');
        const { createHook, executionAsyncId } = require('async_hooks');
        const events = [];
        const hook = createHook({
          init(id, type, triggerId, resource) {
            if (type === 'ResourceName') events.push(['init', id, triggerId, resource.eventEmitter instanceof EventEmitterAsyncResource]);
          },
          before(id) { events.push(['before', id]); },
          after(id) { events.push(['after', id]); },
          destroy(id) { events.push(['destroy', id]); },
        }).enable();
        const rootId = executionAsyncId();
        const emitter = new EventEmitterAsyncResource('ResourceName');
        let listenerAsyncId = 0;
        emitter.on('value', () => { listenerAsyncId = executionAsyncId(); });
        emitter.emit('value');
        emitter.emitDestroy();
        hook.disable();
        process.stdout.write(JSON.stringify({
          asyncId: emitter.asyncId,
          triggerAsyncId: emitter.triggerAsyncId,
          rootId,
          listenerAsyncId,
          sawResource: events.some((entry) => entry[0] === 'init' && entry[3]),
          sawBefore: events.some((entry) => entry[0] === 'before' && entry[1] === emitter.asyncId),
          sawAfter: events.some((entry) => entry[0] === 'after' && entry[1] === emitter.asyncId),
          sawDestroy: events.some((entry) => entry[0] === 'destroy' && entry[1] === emitter.asyncId),
        }));
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        asyncId: expect.any(Number),
        triggerAsyncId: 1,
        rootId: 1,
        listenerAsyncId: expect.any(Number),
        sawResource: true,
        sawBefore: true,
        sawAfter: true,
        sawDestroy: true,
      });
    });

    it("supports deep AsyncResource and AsyncLocalStorage scopes", async () => {
      const result = await runNodeScript(`
        const assert = require('assert');
        const async_hooks = require('async_hooks');
        const { AsyncLocalStorage, AsyncResource } = async_hooks;

        function resourceRecurse(n) {
          const resource = new AsyncResource('deep-resource');
          resource.runInAsyncScope(() => {
            assert.strictEqual(resource.asyncId(), async_hooks.executionAsyncId());
            assert.strictEqual(resource.triggerAsyncId(), async_hooks.triggerAsyncId());
            if (n !== 0) resourceRecurse(n - 1);
            assert.strictEqual(resource.asyncId(), async_hooks.executionAsyncId());
            assert.strictEqual(resource.triggerAsyncId(), async_hooks.triggerAsyncId());
          });
        }

        const als = new AsyncLocalStorage();
        function alsRecurse(n) {
          if (n !== 0) return als.run(n, alsRecurse, n - 1);
          assert.strictEqual(als.getStore(), 1);
        }

        resourceRecurse(1000);
        alsRecurse(1000);
        process.stdout.write('ok');
      `, { timeout: 60_000 });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok");
    });

    it("emits destroy when GC collects userland AsyncResource", async () => {
      const result = await runNodeScript(`
        const { AsyncResource, createHook } = require('async_hooks');
        const destroyed = [];
        const hook = createHook({
          destroy(id) { destroyed.push(id); },
        }).enable();
        let asyncId = 0;
        (function allocateResource() {
          const resource = new AsyncResource('gc-resource');
          asyncId = resource.asyncId();
        })();
        let attempts = 0;
        function checkCollected() {
          if (typeof global.gc === 'function') global.gc();
          if (destroyed.includes(asyncId) || ++attempts >= 10) {
            hook.disable();
            process.stdout.write(JSON.stringify({
              hasGc: typeof global.gc === 'function',
              destroyed: destroyed.includes(asyncId),
            }));
            return;
          }
          setImmediate(checkCollected);
        }
        setImmediate(checkCollected);
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hasGc: true,
        destroyed: true,
      });
    });
  });

  describe.skipIf(!hasNpm)("npm-oriented CommonJS compatibility", () => {
    it("supports EventEmitter class extension and proc-log output events", async () => {
      const result = await runNodeScriptOnHostFs(`
        const EE = require('events');
        class T extends EE { finish() { return 'finish-ok'; } }
        const { output } = require(${JSON.stringify(`${npmDist}/node_modules/proc-log`)});
        const t = new T();
        process.on('output', (...args) => process.stdout.write('SAW:' + JSON.stringify(args) + '\\n'));
        output.standard(t.finish());
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('SAW:["standard","finish-ok"]');
    });

    it("resolves package index.json fallbacks and Module-created require functions", async () => {
      const result = await runNodeScript(`
        const fs = require('fs');
        const path = require('path');
        const Module = require('module');
        const root = '/tmp/npm-resolution';
        const pkg = path.join(root, 'node_modules/json-only');
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'json-only', version: '1.0.0' }));
        fs.writeFileSync(path.join(pkg, 'index.json'), JSON.stringify({ ok: true, source: 'index-json' }));
        fs.writeFileSync(path.join(pkg, 'deprecated.json'), JSON.stringify(['old-id']));

        const mod = new Module(path.join(root, 'probe.js'), module);
        const data = mod.require('json-only');
        const deprecated = mod.require('json-only/deprecated');
        const resolved = Module._resolveFilename('json-only', mod);
        const req = Module.createRequire(path.join(root, 'probe.js'));
        process.stdout.write(JSON.stringify({
          data,
          deprecated,
          resolved: resolved.endsWith('/json-only/index.json'),
          sameCache: req('json-only') === data,
          requireType: typeof mod.require,
          resolveType: typeof Module._resolveFilename,
        }));
      `);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        data: { ok: true, source: "index-json" },
        deprecated: ["old-id"],
        resolved: true,
        sameCache: true,
        requireType: "function",
        resolveType: "function",
      });
    });
  });
});

// External host TCP needs a host-yielding event loop so the Node worker's
// TcpNetworkBackend can process libuv socket events while the wasm runtime is
// waiting. Keep the coverage here as a pending parity target rather than
// pretending the current bridge is complete.
describe.skip(
  "SpiderMonkey Node compatibility parity over real TCP",
  () => {
    let echoServer: net.Server;
    let echoPort: number;

    beforeAll(async () => {
      nodeModule ??= await WebAssembly.compile(loadWasm(nodeWasm!));
      echoServer = net.createServer((socket) => {
        socket.on("data", (data) => {
          socket.write(data);
          socket.end();
        });
      });
      await new Promise<void>((resolve) =>
        echoServer.listen(0, "0.0.0.0", () => resolve()),
      );
      echoPort = (echoServer.address() as net.AddressInfo).port;
    }, 90_000);

    afterAll(async () => {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });

    it("connects with net.Socket and echoes a small payload", { timeout: 40_000 }, async () => {
      const result = await runNodeScript(
        `
          const net = require('net');
          const sock = net.connect(${echoPort}, ${JSON.stringify(wasmDialHost)});
          sock.on('connect', () => sock.write('hello'));
          sock.on('data', (d) => process.stdout.write(d));
          sock.on('end', () => sock.destroy());
        `,
        { enableTcpNetwork: true, timeout: 30_000 },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello");
    });
  },
);
