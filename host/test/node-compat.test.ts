/**
 * Node.js compatibility layer tests.
 *
 * Tests the node.wasm binary which provides Node.js API compatibility
 * via QuickJS-NG. This is NOT Node.js — it's a compatibility layer.
 */

import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";

const nodeWasm = tryResolveBinary("programs/quickjs/node.wasm");
const hasNode = !!nodeWasm;

function loadBytes(p: string): ArrayBuffer {
  const buf = readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(!hasNode)("Node.js compat (node.wasm)", () => {
  it("evaluates a simple expression", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "-e", 'console.log("hello node")'],
    });
    expect(result.stdout).toContain("hello node");
    expect(result.exitCode).toBe(0);
  });

  it("has process global", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        'console.log("arch:", process.arch); console.log("platform:", process.platform); console.log("version:", process.version)',
      ],
    });
    expect(result.stdout).toContain("arch: wasm32");
    expect(result.stdout).toContain("platform: linux");
    expect(result.stdout).toContain("version: v22.0.0");
    expect(result.exitCode).toBe(0);
  });

  it("has Buffer global", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var b = Buffer.from("hello")',
          'console.log("isBuffer:", Buffer.isBuffer(b))',
          'console.log("toString:", b.toString())',
          'console.log("hex:", b.toString("hex"))',
          'console.log("length:", b.length)',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("isBuffer: true");
    expect(result.stdout).toContain("toString: hello");
    expect(result.stdout).toContain("hex: 68656c6c6f");
    expect(result.stdout).toContain("length: 5");
    expect(result.exitCode).toBe(0);
  });

  it("require('path') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var path = require("path")',
          'console.log("join:", path.join("/usr", "bin", "node"))',
          'console.log("dirname:", path.dirname("/usr/bin/node"))',
          'console.log("basename:", path.basename("/usr/bin/node"))',
          'console.log("extname:", path.extname("file.js"))',
          'console.log("isAbsolute:", path.isAbsolute("/usr"))',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("join: /usr/bin/node");
    expect(result.stdout).toContain("dirname: /usr/bin");
    expect(result.stdout).toContain("basename: node");
    expect(result.stdout).toContain("extname: .js");
    expect(result.stdout).toContain("isAbsolute: true");
    expect(result.exitCode).toBe(0);
  });

  it("require('fs') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var fs = require("fs")',
          'fs.writeFileSync("/tmp/node-test.txt", "hello fs")',
          'var data = fs.readFileSync("/tmp/node-test.txt", "utf8")',
          'console.log("read:", data)',
          'console.log("exists:", fs.existsSync("/tmp/node-test.txt"))',
          'fs.unlinkSync("/tmp/node-test.txt")',
          'console.log("deleted:", !fs.existsSync("/tmp/node-test.txt"))',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("read: hello fs");
    expect(result.stdout).toContain("exists: true");
    expect(result.stdout).toContain("deleted: true");
    expect(result.exitCode).toBe(0);
  });

  it("require('events') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var EventEmitter = require("events").EventEmitter',
          'var ee = new EventEmitter()',
          'var received = false',
          'ee.on("test", function(val) { received = val })',
          'ee.emit("test", 42)',
          'console.log("received:", received)',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("received: 42");
    expect(result.exitCode).toBe(0);
  });

  it("require('os') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var os = require("os")',
          'console.log("platform:", os.platform())',
          'console.log("arch:", os.arch())',
          'console.log("EOL:", JSON.stringify(os.EOL))',
          'console.log("tmpdir:", os.tmpdir())',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain('platform: linux');
    expect(result.stdout).toContain('arch: wasm32');
    expect(result.stdout).toContain('EOL: "\\n"');
    expect(result.stdout).toContain('tmpdir: /tmp');
    expect(result.exitCode).toBe(0);
  });

  it("require('util') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var util = require("util")',
          'console.log("format:", util.format("hello %s %d", "world", 42))',
          'console.log("inspect:", util.inspect({a: 1, b: [2, 3]}))',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("format: hello world 42");
    expect(result.stdout).toContain("inspect:");
    expect(result.exitCode).toBe(0);
  });

  it("require with node: prefix works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var path = require("node:path")',
          'var fs = require("node:fs")',
          'console.log("path.sep:", path.sep)',
          'console.log("fs.constants:", typeof fs.constants)',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("path.sep: /");
    expect(result.stdout).toContain("fs.constants: object");
    expect(result.exitCode).toBe(0);
  });

  it("process.argv works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "-e", 'console.log("argv:", JSON.stringify(process.argv))'],
    });
    expect(result.stdout).toContain("argv:");
    // argv should be an array
    const match = result.stdout.match(/argv: (\[.*\])/);
    expect(match).toBeTruthy();
    const argv = JSON.parse(match![1]);
    expect(Array.isArray(argv)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("prints version with --version", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: ["node", "--version"],
    });
    expect(result.stdout).toContain("v22.0.0");
    expect(result.exitCode).toBe(0);
  });

  it("require('assert') works", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      argv: [
        "node", "-e",
        [
          'var assert = require("assert")',
          'assert.strictEqual(1, 1)',
          'assert.deepStrictEqual({a: 1}, {a: 1})',
          'console.log("assert: ok")',
        ].join(";"),
      ],
    });
    expect(result.stdout).toContain("assert: ok");
    expect(result.exitCode).toBe(0);
  });
});

/* Dynamic TTY behaviors require a real PTY (isatty(fd) must be true) plus the
   ability to drive ptyResize / ptyWrite from the host while the process is
   running. runCentralizedProgram uses a stdin buffer with no TTY, so these
   tests fall through to NodeKernelHost directly. */
describe.skipIf(!hasNode)("Node.js compat (node.wasm) — dynamic TTY", () => {
  async function runUnderPty(
    src: string,
    drive: (h: NodeKernelHost, getPid: () => number, waitFor: (s: string) => Promise<void>) => Promise<void>,
    spawnOpts: { ptyCols?: number; ptyRows?: number } = {},
  ): Promise<{ exitCode: number; out: string }> {
    let out = "";
    const host = new NodeKernelHost({
      maxWorkers: 1,
      onStdout: () => {},
      onStderr: () => {},
      onPtyOutput: (_pid, data) => { out += new TextDecoder().decode(data); },
    });
    await host.init();

    const waitFor = async (needle: string, timeoutMs = 8000): Promise<void> => {
      const start = Date.now();
      while (!out.includes(needle)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`timeout waiting for ${JSON.stringify(needle)}; got: ${JSON.stringify(out)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    let pid = -1;
    const exitPromise = host.spawn(loadBytes(nodeWasm), ["node", "-e", src], {
      pty: true,
      ...spawnOpts,
      onStarted: (p) => { pid = p; },
    });

    try {
      await drive(host, () => pid, waitFor);
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("exit timeout")), 10_000)),
      ]);
      return { exitCode, out };
    } finally {
      await host.destroy().catch(() => {});
    }
  }

  it("process.stdout.columns / rows track PTY resize live", async () => {
    const src = [
      "process.stdout.write('READY\\n');",
      "process.stdin.once('data', () => {",
      "  process.stdout.write('A ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');",
      "  process.stdin.once('data', () => {",
      "    process.stdout.write('B ' + process.stderr.columns + 'x' + process.stderr.rows + '\\n');",
      "    process.exit(0);",
      "  });",
      "});",
    ].join(" ");

    const { exitCode, out } = await runUnderPty(src, async (host, getPid, waitFor) => {
      await waitFor("READY");
      // Round 1: 150×100 → first sample
      host.ptyResize(getPid(), 100, 150);
      await new Promise((r) => setTimeout(r, 100));
      host.ptyWrite(getPid(), new TextEncoder().encode("x\n"));
      await waitFor("A ");
      // Round 2: 60×50 → different sample, proving no caching
      host.ptyResize(getPid(), 50, 60);
      await new Promise((r) => setTimeout(r, 100));
      host.ptyWrite(getPid(), new TextEncoder().encode("x\n"));
      await waitFor("B ");
    });

    expect(out).toContain("A 150x100");
    expect(out).toContain("B 60x50");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("process.stdin.setRawMode disables line discipline (single byte delivered without newline)", async () => {
    const src = [
      "process.stdin.setRawMode(true);",
      "process.stdout.write('READY isRaw=' + process.stdin.isRaw + '\\n');",
      "process.stdin.once('data', (d) => {",
      "  process.stdout.write('GOT:' + d.length + ' byte=' + d[0] + '\\n');",
      "  process.exit(0);",
      "});",
    ].join(" ");

    const { exitCode, out } = await runUnderPty(src, async (host, getPid, waitFor) => {
      await waitFor("READY isRaw=true");
      // Send a single 'a' (0x61) with NO newline. In cooked mode the kernel's
      // line discipline would buffer until '\n'; in raw mode it delivers now.
      host.ptyWrite(getPid(), new Uint8Array([0x61]));
      await waitFor("GOT:1");
    });

    expect(out).toContain("READY isRaw=true");
    expect(out).toContain("GOT:1 byte=97");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("pre-spawn ptyCols/ptyRows are visible to the program at startup", async () => {
    const src = [
      "process.stdout.write('A ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');",
      "process.exit(0);",
    ].join(" ");

    const { exitCode, out } = await runUnderPty(
      src,
      async (_host, _getPid, waitFor) => { await waitFor("A "); },
      { ptyCols: 142, ptyRows: 38 },
    );

    expect(out).toContain("A 142x38");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("process.stdout.on('resize') fires with the new dimensions after ptyResize", async () => {
    const src = [
      "process.stdout.write('READY\\n');",
      "process.stdout.on('resize', () => {",
      "  process.stdout.write('R ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n');",
      "  process.exit(0);",
      "});",
      // Keep the event loop alive until SIGWINCH lands.
      "setTimeout(() => process.exit(1), 5000);",
    ].join(" ");

    const { exitCode, out } = await runUnderPty(src, async (host, getPid, waitFor) => {
      await waitFor("READY");
      host.ptyResize(getPid(), 38, 142);
      await waitFor("R ");
    });

    expect(out).toContain("R 142x38");
    expect(exitCode).toBe(0);
  }, 30_000);
});
