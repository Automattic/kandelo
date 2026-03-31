/**
 * Tests for dash shell running on the wasm-posix-kernel.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashBinary = join(
  __dirname,
  "../../examples/libs/dash/dash-src/src/dash",
);

const hasDash = existsSync(dashBinary);

describe.skipIf(!hasDash)("dash shell", () => {
  it("runs echo via -c", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "echo hello world"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("runs variable assignment and expansion", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "X=42; echo $X"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  it("runs command substitution", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "echo $(echo nested)"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("nested");
  });

  it("runs conditionals", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", 'if true; then echo yes; else echo no; fi'],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("yes");
  });

  it("runs a for loop", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "for i in a b c; do echo $i; done"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("a\nb\nc");
  });

  it("exits with the correct status", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "exit 7"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(7);
  });

  it("reads environment variables", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "echo $MY_VAR"],
      env: ["MY_VAR=kernel_test"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("kernel_test");
  });

  it("supports arithmetic expansion", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "echo $((2 + 3 * 4))"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("14");
  });

  it("supports while loop", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0\n1\n2");
  });

  it("supports functions", async () => {
    const result = await runCentralizedProgram({
      programPath: dashBinary,
      argv: ["dash", "-c", "greet() { echo \"hello $1\"; }; greet world"],
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });
});
