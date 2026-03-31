/**
 * Tests for execve support — loading a new program binary into an existing process.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(__dirname, "../wasm");

const execPrograms = new Map<string, string>([
  ["/bin/exec-child", join(wasmDir, "exec-child.wasm")],
]);

describe("execve", () => {
  it("replaces the current process with a new program", async () => {
    const result = await runCentralizedProgram({
      programPath: join(wasmDir, "exec-caller.wasm"),
      argv: ["exec-caller"],
      timeout: 15_000,
      execPrograms,
    });

    // exec-child exits with 42
    expect(result.exitCode).toBe(42);

    // exec-child prints its argv
    expect(result.stdout).toContain("argc=3");
    expect(result.stdout).toContain("argv[0]=exec-child");
    expect(result.stdout).toContain("argv[1]=hello");
    expect(result.stdout).toContain("argv[2]=world");

    // exec-child prints env vars passed by exec-caller
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("TEST=exec");
  });

  it("fork + exec: child execs while parent waits", async () => {
    const result = await runCentralizedProgram({
      programPath: join(wasmDir, "fork-exec.wasm"),
      argv: ["fork-exec"],
      timeout: 15_000,
      execPrograms,
    });

    // Parent exits 0
    expect(result.exitCode).toBe(0);

    // Parent reports child exit status (42 from exec-child)
    expect(result.stdout).toContain("child exited with 42");

    // exec-child's stdout is also captured (shares fd 1)
    expect(result.stdout).toContain("argc=2");
    expect(result.stdout).toContain("argv[0]=exec-child");
    expect(result.stdout).toContain("argv[1]=from-fork");
    expect(result.stdout).toContain("FROM=fork");
  });
});
