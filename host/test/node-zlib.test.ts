import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync as hostGzipSync, deflateSync as hostDeflateSync } from "node:zlib";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = join(__dirname, "../../examples/libs/quickjs/bin/node.wasm");
const HAS_NODE = existsSync(NODE);

async function runNodeScript(src: string) {
  return runCentralizedProgram({
    programPath: NODE,
    argv: ["node", "-e", src],
    timeout: 20_000,
  });
}

describe.skipIf(!HAS_NODE)("node.wasm zlib (libz-backed)", () => {
  it("gzipSync + gunzipSync round-trip a Buffer", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const input = Buffer.from('hello world');
      const out = zlib.gunzipSync(zlib.gzipSync(input)).toString();
      process.stdout.write(out);
    `);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello world");
  });

  it("gzipSync output starts with the gzip magic bytes 1f 8b", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const gz = zlib.gzipSync(Buffer.from('hello'));
      process.stdout.write(gz[0].toString(16) + ' ' + gz[1].toString(16));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1f 8b");
  });

  it("deflateSync + inflateSync round-trip a Buffer (zlib format)", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const input = Buffer.from('the quick brown fox jumps over the lazy dog');
      const out = zlib.inflateSync(zlib.deflateSync(input)).toString();
      process.stdout.write(out);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("gunzips data produced by the host's native zlib byte-for-byte", async () => {
    const original = "package/\nREADME.md\n";
    const hostGz = hostGzipSync(Buffer.from(original));
    const hostGzHex = hostGz.toString("hex");
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const gz = Buffer.from(${JSON.stringify(hostGzHex)}, 'hex');
      process.stdout.write(zlib.gunzipSync(gz).toString());
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(original);
  });

  it("inflates raw zlib data produced by the host's native deflate", async () => {
    const original = "interop check between host zlib and wasm libz";
    const hostDef = hostDeflateSync(Buffer.from(original));
    const hostDefHex = hostDef.toString("hex");
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const def = Buffer.from(${JSON.stringify(hostDefHex)}, 'hex');
      process.stdout.write(zlib.inflateSync(def).toString());
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(original);
  });

  it("compresses a large repetitive payload (>4 KiB) below 1 KiB", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const buf = Buffer.alloc(8192, 'A');
      const gz = zlib.gzipSync(buf);
      const round = zlib.gunzipSync(gz);
      process.stdout.write('len=' + gz.length + ' eq=' + Buffer.compare(buf, round));
    `);
    expect(r.exitCode).toBe(0);
    const m = /^len=(\d+) eq=(-?\d+)$/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(0);
    expect(Number(m![1])).toBeLessThan(1024);
  });

  it("createGzip/createGunzip stream a chunked payload identical to monolithic gzipSync", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const buf = Buffer.alloc(8192);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + (i >> 3)) & 0xff;

      const mono = zlib.gzipSync(buf);

      const gz = zlib.createGzip();
      const out = [];
      gz.on('data', (d) => out.push(d));
      gz.on('end', () => {
        const streamed = Buffer.concat(out);
        const round = zlib.gunzipSync(streamed);
        process.stdout.write(
          'mono=' + mono.length +
          ' streamed=' + streamed.length +
          ' eq=' + Buffer.compare(buf, round)
        );
      });
      for (let i = 0; i < buf.length; i += 333) gz.write(buf.slice(i, i + 333));
      gz.end();
    `);
    expect(r.exitCode).toBe(0);
    const m = /^mono=(\d+) streamed=(\d+) eq=(-?\d+)$/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBe(0);
  });

  it("createDeflate/createInflate stream a chunked payload identical to monolithic", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const buf = Buffer.alloc(4096);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) & 0xff;
      const mono = zlib.deflateSync(buf);

      const def = zlib.createDeflate();
      const out = [];
      def.on('data', (d) => out.push(d));
      def.on('end', () => {
        const streamed = Buffer.concat(out);
        const round = zlib.inflateSync(streamed);
        process.stdout.write(
          'mono=' + mono.length +
          ' streamed=' + streamed.length +
          ' eq=' + Buffer.compare(buf, round)
        );
      });
      for (let i = 0; i < buf.length; i += 257) def.write(buf.slice(i, i + 257));
      def.end();
    `);
    expect(r.exitCode).toBe(0);
    const m = /^mono=\d+ streamed=\d+ eq=(-?\d+)$/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0);
  });

  it("createGunzip streams the decompression of a chunked gzip payload", async () => {
    const original = Buffer.alloc(2048);
    for (let i = 0; i < original.length; i++) original[i] = (i ^ 0x5a) & 0xff;
    const hostGz = hostGzipSync(original);
    const hostGzHex = hostGz.toString("hex");
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const gz = Buffer.from(${JSON.stringify(hostGzHex)}, 'hex');
      const u = zlib.createGunzip();
      const out = [];
      u.on('data', (d) => out.push(d));
      u.on('end', () => {
        const result = Buffer.concat(out);
        const want = Buffer.alloc(2048);
        for (let i = 0; i < want.length; i++) want[i] = (i ^ 0x5a) & 0xff;
        process.stdout.write('len=' + result.length + ' eq=' + Buffer.compare(want, result));
      });
      for (let i = 0; i < gz.length; i += 100) u.write(gz.slice(i, i + 100));
      u.end();
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("len=2048 eq=0");
  });

  it("accepts a string input on gzipSync (utf-8 encoded)", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const gz = zlib.gzipSync('héllo');
      const round = zlib.gunzipSync(gz).toString('utf8');
      process.stdout.write(round);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("héllo");
  });

  it("rejects an invalid compression level", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      try { zlib.gzipSync(Buffer.from('x'), { level: 42 }); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });

  it("returns a Buffer (not Uint8Array) from sync helpers", async () => {
    const r = await runNodeScript(`
      const zlib = require('zlib');
      const gz = zlib.gzipSync(Buffer.from('abc'));
      const out = zlib.gunzipSync(gz);
      process.stdout.write(
        'gzBuf=' + Buffer.isBuffer(gz) +
        ' outBuf=' + Buffer.isBuffer(out)
      );
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("gzBuf=true outBuf=true");
  });
});
