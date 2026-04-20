/**
 * Integration test for Node.js (v24.14.1) compiled to wasm32 running on wasm-posix-kernel.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { runCentralizedProgram } from "./centralized-test-helper";

const nodeBinary =
  "/Users/brandon/.superset/worktrees/wasm-posix-kernel/nodejs-port/examples/libs/nodejs/nodejs-build/node-v24.14.1/out/Release/node-stripped.wasm";

const hasNode = existsSync(nodeBinary);

const V8_FLAGS = "--scavenger-conservative-object-pinning";

function runNode(code: string, timeout = 60_000) {
  return runCentralizedProgram({
    programPath: nodeBinary,
    argv: ["node", V8_FLAGS, "-e", code],
    timeout,
  });
}

describe.skipIf(!hasNode)("Node.js wasm32", () => {
  it("prints hello via console.log", async () => {
    const result = await runNode("console.log('hello')");
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("evaluates string concatenation", async () => {
    const result = await runNode("console.log('a' + 'b')");
    expect(result.stdout).toContain("ab");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("JSON.stringify works", async () => {
    const result = await runNode("console.log(JSON.stringify({a:1}))");
    expect(result.stdout).toContain('{"a":1}');
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("evaluates arithmetic to string", async () => {
    const result = await runNode("console.log(String(2 + 3))");
    expect(result.stdout).toContain("5");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("template literals", async () => {
    const result = await runNode("console.log(`hello ${'world'}`)");
    expect(result.stdout).toContain("hello world");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("typeof operator", async () => {
    const result = await runNode("console.log(typeof undefined)");
    expect(result.stdout).toContain("undefined");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("Number.prototype.toString", async () => {
    const result = await runNode("console.log((42).toString())");
    expect(result.stdout).toContain("42");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("console.log with number argument", async () => {
    const result = await runNode("console.log(2 + 3)");
    expect(result.stdout).toContain("5");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("console.log with boolean", async () => {
    const result = await runNode("console.log(true)");
    expect(result.stdout).toContain("true");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("console.log with null", async () => {
    const result = await runNode("console.log(null)");
    expect(result.stdout).toContain("null");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("process.argv.length", async () => {
    const result = await runNode("console.log(process.argv.length)");
    expect(result.stdout.trim()).toMatch(/^\d+$/);
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("process.exit(0)", async () => {
    const result = await runNode("process.exit(0)");
    expect(result.exitCode).toBe(0);
  }, 70_000);

  it("process.exit(1)", async () => {
    const result = await runNode("process.exit(1)");
    expect(result.exitCode).toBe(1);
  }, 70_000);

  it("process.exit(42)", async () => {
    const result = await runNode("process.exit(42)");
    expect(result.exitCode).toBe(42);
  }, 70_000);

  it("stderr is clean (no trace output)", async () => {
    const result = await runNode("console.log('test')");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 70_000);
});
