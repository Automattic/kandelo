/**
 * Node.js compatibility layer tests.
 *
 * Tests the node.wasm binary which provides Node.js API compatibility
 * via QuickJS-NG. This is NOT Node.js — it's a compatibility layer.
 */

import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const nodeWasm = tryResolveBinary("programs/quickjs/node.wasm");
const hasNode = !!nodeWasm;

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
