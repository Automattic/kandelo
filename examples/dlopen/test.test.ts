/**
 * Vitest integration test for the dlopen example.
 *
 * Builds and runs the dlopen example, verifying that:
 * - hello-lib.so loads via dlopen
 * - Functions are callable via dlsym'd pointers
 * - Global state (call_count) works in shared library
 * - dlsym returns null for missing symbols
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const hasSysroot = existsSync(resolve(REPO_ROOT, "sysroot/lib/libc.a"));
const hasKernel = existsSync(resolve(REPO_ROOT, "host/wasm/wasm_posix_kernel.wasm"));

describe.skipIf(!hasSysroot || !hasKernel)("dlopen example", () => {
  beforeAll(() => {
    // Build the example
    execSync(`bash ${resolve(__dirname, "build.sh")}`, {
      stdio: "pipe",
      cwd: REPO_ROOT,
    });
  });

  it("loads shared library and calls functions via dlopen/dlsym", async () => {
    const result = await runCentralizedProgram({
      programPath: resolve(__dirname, "main.wasm"),
      argv: ["main", resolve(__dirname, "hello-lib.so")],
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Library loaded successfully");
    expect(result.stdout).toContain("add(3, 4) = 7");
    expect(result.stdout).toContain("add(100, 200) = 300");
    expect(result.stdout).toContain("multiply(5, 6) = 30");
    expect(result.stdout).toContain("call_count = 3");
    expect(result.stdout).toContain("Hello from a dynamically loaded library!");
    expect(result.stdout).toContain("Expected: symbol not found");
    expect(result.stdout).toContain("Library unloaded. Done.");
  });
});
