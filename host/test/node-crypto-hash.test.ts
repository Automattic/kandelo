import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe.skipIf(!HAS_NODE)("node.wasm crypto.createHash (EVP-backed)", () => {
  // RFC 3174 / NIST FIPS 180-4 / RFC 1321 known-answer vectors.
  it.each<[string, string, string]>([
    ["sha1",   "",    "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["sha1",   "abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["sha256", "",    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["sha256", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["sha512", "",    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"],
    ["sha512", "abc", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"],
    ["md5",    "",    "d41d8cd98f00b204e9800998ecf8427e"],
    ["md5",    "abc", "900150983cd24fb0d6963f7d28e17f72"],
  ])("%s of %j matches the canonical KAT vector", async (algo, input, want) => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      process.stdout.write(crypto.createHash(${JSON.stringify(algo)})
        .update(${JSON.stringify(input)}).digest('hex'));
    `);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(want);
  });

  it("accepts Buffer input on update()", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHash('sha256').update(Buffer.from('abc')).digest('hex');
      process.stdout.write(h);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("supports chained update() calls", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHash('sha256')
        .update('a').update('b').update('c').digest('hex');
      process.stdout.write(h);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns a Buffer when digest() is called without encoding", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const d = crypto.createHash('sha256').update('abc').digest();
      process.stdout.write(Buffer.isBuffer(d) ? 'Buffer ' + d.length : 'NOT_BUFFER');
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("Buffer 32");
  });

  it("supports base64 encoding on digest()", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      process.stdout.write(crypto.createHash('sha256').update('abc').digest('base64'));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  it("hashes a >1KB Buffer chunked the same as monolithic", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const buf = Buffer.alloc(4096);
      for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
      const monolithic = crypto.createHash('sha256').update(buf).digest('hex');
      const chunked = crypto.createHash('sha256');
      for (let i = 0; i < buf.length; i += 333) chunked.update(buf.slice(i, i + 333));
      process.stdout.write(monolithic + ' ' + chunked.digest('hex'));
    `);
    expect(r.exitCode).toBe(0);
    const [a, b] = r.stdout.split(" ");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("two concurrent Hash instances do not share state", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h1 = crypto.createHash('sha256');
      const h2 = crypto.createHash('sha256');
      h1.update('abc');
      h2.update('xyz');
      process.stdout.write(h1.digest('hex') + ' ' + h2.digest('hex'));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad " +
        "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282",
    );
  });

  it("rejects null and undefined algorithm", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      let nullThrew = false, undefThrew = false;
      try { crypto.createHash(null); } catch (e) { nullThrew = true; }
      try { crypto.createHash(undefined); } catch (e) { undefThrew = true; }
      process.stdout.write(nullThrew + ' ' + undefThrew);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("true true");
  });

  it("rejects unsupported algorithms", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      try { crypto.createHash('not-a-real-algo'); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });

  it("throws when update() is called after digest()", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHash('sha256');
      h.update('abc');
      h.digest();
      try { h.update('more'); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });
});
