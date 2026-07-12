/**
 * Tests for execve support — loading a new program binary into an existing process.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.skipIf(!hasExecCaller)("rejects malformed Wasm before committing exec", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kandelo-exec-malformed-wasm-"));
    const malformedWasm = join(tempDir, "malformed.wasm");
    try {
      // Valid Wasm magic/version with a truncated type section. This reaches
      // compilation, which must fail before kernelExecSetup discards the old
      // process image.
      writeFileSync(malformedWasm, Buffer.from([
        0x00, 0x61, 0x73, 0x6d,
        0x01, 0x00, 0x00, 0x00,
        0x01, 0x01, 0xff,
      ]));

      const result = await runCentralizedProgram({
        programPath: execCallerBinary!,
        argv: ["exec-caller"],
        timeout: 15_000,
        execPrograms: new Map([
          ["/bin/exec-child", malformedWasm],
        ]),
      });

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("Exec format error");
      expect(result.stderr).not.toContain("Centralized worker failed");
      expect(result.stderr).not.toContain("WebAssembly.compile()");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
