import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { persistentRealmMemoryFailures } from "./support/browser-memory-boundary";
import { auditBrowserMessageTypes } from "./support/audit-browser-message-types";
import { repositoryRuntimeSourceFiles } from "../../../host/test/support/wasm-memory-write-audit";

test("runtime ownership inventory excludes test configs and retains production config modules", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-memory-inventory-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, "host/src"), { recursive: true });
    for (const name of ["host/vitest.config.ts", "host/vitest.browser-memory.config.ts",
      "host/src/vitest.browser-memory.config.ts"]) {
      writeFileSync(join(root, name), "export const memory = new WebAssembly.Memory({ initial: 1 });");
    }
    assert.deepEqual(repositoryRuntimeSourceFiles(root).map(file => relative(root, file)), [
      "host/src/vitest.browser-memory.config.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser protocol declarations expose no whole guest memories or unreviewed shared buffers", () => {
  assert.deepEqual(auditBrowserMessageTypes(), []);
});

test("protocol audit follows nested payloads and catches the former framebuffer and audio designs", () => {
  const failures = auditBrowserMessageTypes(`KernelToMainMessage
    | { type: "bad_framebuffer"; memory: WebAssembly.Memory }
    | { type: "bad_ready"; transport: { buffer: SharedArrayBuffer } }`);
  assert.ok(failures.some(failure => failure.startsWith("bad_framebuffer.memory:")));
  assert.ok(failures.some(failure => failure.startsWith("bad_ready.transport.buffer:")));
});

test("memory probe rejects whole guest memories, including nested RPC results", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
  assert.match(persistentRealmMemoryFailures({ type: "fb_bind", memory }).join(), /whole WebAssembly.Memory/);
  assert.match(persistentRealmMemoryFailures({ type: "response", result: { memory } }).join(), /message.result.memory/);
  const containers = new Map([[memory, new Set([new Uint8Array(memory.buffer, 0, 1)])]]);
  assert.equal(persistentRealmMemoryFailures({ type: "response", result: containers }).length, 2);
});

test("memory probe rejects a tiny audio view retaining a whole shared backing", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16, shared: true });
  assert.match(persistentRealmMemoryFailures({ type: "ready", transport: {
    words: new Int32Array(memory.buffer, 0, 1),
  } }).join(), /shared view retains its entire backing/);
  assert.match(persistentRealmMemoryFailures({ type: "ready", transport: {
    buffer: memory.buffer,
  } }).join(), /unreviewed shared backing/);
});

test("memory probe admits independent fixed pixels and copied ordinary bytes", () => {
  assert.deepEqual(persistentRealmMemoryFailures({
    type: "fb_bind", len: 16, pixels: new SharedArrayBuffer(16),
  }), []);
  assert.deepEqual(persistentRealmMemoryFailures({
    type: "response", result: { bytes: new Uint8Array(16), image: new ArrayBuffer(8) },
  }), []);
});

test("memory probe rejects oversized, growable, and disguised shared pixel buffers", () => {
  assert.equal(persistentRealmMemoryFailures({
    type: "fb_bind", len: 16, pixels: new SharedArrayBuffer(32),
  }).length, 1);
  assert.equal(persistentRealmMemoryFailures({
    type: "fb_bind", len: 16,
    pixels: new SharedArrayBuffer(16, { maxByteLength: 32 }),
  }).length, 1);
  assert.equal(persistentRealmMemoryFailures({
    type: "response", result: { pixels: new SharedArrayBuffer(16) },
  }).length, 1);
});

for (const type of ["gl_forward_query", "gl_forward_create_context"]) {
  test(`memory probe admits only the fixed independent ${type} mailbox`, () => {
    const mailbox = new SharedArrayBuffer(20 + 65536);
    assert.deepEqual(persistentRealmMemoryFailures({ type, mailbox }), []);
    for (const invalid of [
      new SharedArrayBuffer(65536),
      new SharedArrayBuffer(20 + 65536, { maxByteLength: 20 + 65536 }),
      new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer,
    ]) {
      assert.equal(persistentRealmMemoryFailures({ type, mailbox: invalid }).length, 1);
    }
    assert.equal(persistentRealmMemoryFailures({ type: "response", result: { mailbox } }).length, 1);
    assert.equal(persistentRealmMemoryFailures({ type, mailbox,
      input: new Uint8Array(new SharedArrayBuffer(65536), 0, 1) }).length, 1);
  });
}
