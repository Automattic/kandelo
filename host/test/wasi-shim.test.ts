/**
 * Integration tests for WASI Preview 1 compatibility shim.
 *
 * Runs hand-written WASI .wasm binaries through CentralizedKernelWorker
 * and verifies behavior (stdout output, args, etc.).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

describe("WASI shim", () => {
  it("hello world via fd_write", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-hello.wasm"),
      timeout: 10_000,
    });
    expect(result.stdout).toBe("Hello from WASI\n");
    expect(result.exitCode).toBe(0);
  });

  it("args_get passes argv to the program", async () => {
    const result = await runCentralizedProgram({
      programPath: join(fixturesDir, "wasi-args.wasm"),
      argv: ["wasi-args", "test-argument-value"],
      timeout: 10_000,
    });
    expect(result.stdout).toBe("test-argument-value\n");
    expect(result.exitCode).toBe(0);
  });
});
