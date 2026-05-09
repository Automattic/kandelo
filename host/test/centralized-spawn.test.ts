/**
 * Non-forking posix_spawn — basic flow + fork-counter regression guardrail.
 *
 * The guardrail is the load-bearing assertion: SYS_SPAWN must NOT bump
 * the parent's `fork_count`. If it does, the spawn path is silently
 * falling back to `kernel_fork_process` (which does bump the counter)
 * and the whole "non-forking" claim of this PR is wrong.
 *
 * Companion smoke C program: `examples/spawn-smoke.c`.
 */

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const spawnSmokeWasm = join(repoRoot, "examples", "spawn-smoke.wasm");
const helloWasm = join(repoRoot, "examples", "hello.wasm");

describe("non-forking posix_spawn", () => {
  it("runs spawn-smoke and the parent's fork_count stays 0", async () => {
    // Spawn a child program that lives in examples/ — keeps the test free
    // of the binaries-cache fetch. spawn-smoke takes the child path as
    // argv[1] and just exec-equivalents it via posix_spawn + waitpid.
    const result = await runCentralizedProgram({
      programPath: spawnSmokeWasm,
      argv: ["spawn-smoke", "/usr/bin/hello"],
      execPrograms: new Map([
        ["/usr/bin/hello", helloWasm],
      ]),
      timeout: 30_000,
      captureForkCount: true,
    });

    expect(result.exitCode).toBe(0);
    // spawn-smoke prints "OK" after the child reaped successfully.
    expect(result.stdout).toContain("OK");
    // The spawn child is hello.wasm, which prints its greeting.
    expect(result.stdout).toContain("Hello from musl");
    // GUARDRAIL: spawn must not increment the parent's fork counter.
    // A non-zero value here means SYS_SPAWN silently fell back to fork.
    expect(result.forkCount).toBe(0n);
  });
});
