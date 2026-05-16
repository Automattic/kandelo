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

describe.skipIf(!HAS_NODE)("node.wasm crypto.createHmac (EVP_MAC-backed)", () => {
  // RFC 4231 (HMAC-SHA), RFC 2202 (HMAC-SHA1, HMAC-MD5) test vectors.
  // Key/data are ASCII; KAT cases here reuse the canonical "Hi There" / "Jefe" pairs.
  it.each<[string, string, string, string]>([
    // [algo, key, data, expected hex]
    ["sha1",   "Jefe", "what do ya want for nothing?", "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"],
    ["sha256", "Jefe", "what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    ["sha512", "Jefe", "what do ya want for nothing?", "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"],
    ["md5",    "Jefe", "what do ya want for nothing?", "750c783e6ab0b503eaa86e310a5db738"],
  ])("%s with key %j matches the canonical KAT vector", async (algo, key, data, want) => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      process.stdout.write(crypto.createHmac(${JSON.stringify(algo)}, ${JSON.stringify(key)})
        .update(${JSON.stringify(data)}).digest('hex'));
    `);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(want);
  });

  it("accepts Buffer key and Buffer data", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHmac('sha256', Buffer.from('Jefe'))
        .update(Buffer.from('what do ya want for nothing?'))
        .digest('hex');
      process.stdout.write(h);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("supports chained update() calls", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHmac('sha256', 'Jefe')
        .update('what do ya ').update('want for ').update('nothing?').digest('hex');
      process.stdout.write(h);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("returns a Buffer when digest() is called without encoding", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const d = crypto.createHmac('sha256', 'k').update('x').digest();
      process.stdout.write(Buffer.isBuffer(d) ? 'Buffer ' + d.length : 'NOT_BUFFER');
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("Buffer 32");
  });

  it("supports base64 encoding on digest()", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      process.stdout.write(crypto.createHmac('sha256', 'Jefe')
        .update('what do ya want for nothing?').digest('base64'));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
  });

  it("two concurrent Hmac instances do not share state", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h1 = crypto.createHmac('sha256', 'k1');
      const h2 = crypto.createHmac('sha256', 'k2');
      h1.update('abc');
      h2.update('xyz');
      process.stdout.write(h1.digest('hex') + ' ' + h2.digest('hex'));
    `);
    expect(r.exitCode).toBe(0);
    // Different keys must yield different digests.
    const [a, b] = r.stdout.split(" ");
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
  });

  it("rejects unsupported algorithms", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      try { crypto.createHmac('not-a-real-algo', 'k'); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });

  it("rejects null and undefined algorithm", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      let nullThrew = false, undefThrew = false;
      try { crypto.createHmac(null, 'k'); } catch (e) { nullThrew = true; }
      try { crypto.createHmac(undefined, 'k'); } catch (e) { undefThrew = true; }
      process.stdout.write(nullThrew + ' ' + undefThrew);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("true true");
  });

  it("requires a key argument", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      try { crypto.createHmac('sha256'); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });

  it("throws when update() is called after digest()", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const h = crypto.createHmac('sha256', 'k');
      h.update('abc');
      h.digest();
      try { h.update('more'); process.stdout.write('NO_THROW'); }
      catch (e) { process.stdout.write('threw'); }
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("threw");
  });

  it("differs from createHash for the same data — proves key is not ignored", async () => {
    const r = await runNodeScript(`
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', 'somekey').update('abc').digest('hex');
      const hash = crypto.createHash('sha256').update('abc').digest('hex');
      process.stdout.write(hmac === hash ? 'SAME' : 'DIFFERENT');
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("DIFFERENT");
  });
});
