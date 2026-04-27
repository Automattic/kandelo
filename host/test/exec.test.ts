/**
 * Tests for execve support — loading a new program binary into an existing process.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const execCallerBinary = tryResolveBinary("programs/exec-caller.wasm");
const execChildBinary = tryResolveBinary("programs/exec-child.wasm");
const forkExecBinary = tryResolveBinary("programs/fork-exec.wasm");

const execPrograms = new Map<string, string>(
  execChildBinary ? [["/bin/exec-child", execChildBinary]] : [],
);

const hasExecCaller = !!execCallerBinary;
const hasForkExec = !!forkExecBinary;

describe("execve", () => {
  it.skipIf(!hasExecCaller)("replaces the current process with a new program", async () => {
    const result = await runCentralizedProgram({
      programPath: execCallerBinary!,
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

  it.skipIf(!hasForkExec)("fork + exec: child execs while parent waits", async () => {
    const result = await runCentralizedProgram({
      programPath: forkExecBinary!,
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
