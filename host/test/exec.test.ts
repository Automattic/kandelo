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
const vforkLifecycleBinary = tryResolveBinary("programs/vfork-lifecycle.wasm");

const execPrograms = new Map<string, string>(
  execChildBinary ? [["/bin/exec-child", execChildBinary]] : [],
);

const hasExecCaller = !!execCallerBinary;
const hasForkExec = !!forkExecBinary;
const hasVforkLifecycle = !!vforkLifecycleBinary && !!execChildBinary;

describe("execve", () => {
  it.skipIf(!hasExecCaller)("replaces the current process with a new program", async () => {
    const result = await runCentralizedProgram({
      programPath: execCallerBinary!,
      argv: ["exec-caller"],
      timeout: 15_000,
      execPrograms,
      useDefaultRootfs: false,
    });

    // exec-child exits with 42
    expect(result.exitCode).toBe(42);

    // exec-child prints its argv
    expect(result.stdout).toContain("argc=3");
    expect(result.stdout).toContain("argv[0]=/opt/kandelo/bin/exec-child");
    expect(result.stdout).toContain("argv[1]=hello");
    expect(result.stdout).toContain("argv[2]=world");
    expect(result.stdout).toContain(
      "program_invocation_name=/opt/kandelo/bin/exec-child",
    );
    expect(result.stdout).toContain("program_invocation_short_name=exec-child");

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
      useDefaultRootfs: false,
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

  it.skipIf(!hasExecCaller || !execChildBinary)(
    "replaces a shebang script target with its exact interpreter once",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "kandelo-exec-shebang-"));
      const scriptPath = join(tempDir, "script");
      try {
        writeFileSync(
          scriptPath,
          "#!/bin/exact-interpreter --script-flag\nignored body\n",
          { mode: 0o4755 },
        );
        const result = await runCentralizedProgram({
          programPath: execCallerBinary!,
          argv: ["exec-caller"],
          timeout: 15_000,
          execPrograms: new Map([
            ["/bin/exec-child", scriptPath],
            ["/bin/exact-interpreter", execChildBinary!],
          ]),
          useDefaultRootfs: false,
        });

        expect(result.exitCode).toBe(42);
        expect(result.stdout).toContain("argc=5");
        expect(result.stdout).toContain("argv[0]=/bin/exact-interpreter");
        expect(result.stdout).toContain("argv[1]=--script-flag");
        expect(result.stdout).toContain("argv[2]=/bin/exec-child");
        expect(result.stdout).toContain("argv[3]=hello");
        expect(result.stdout).toContain("argv[4]=world");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasExecCaller)("rejects malformed Wasm before committing exec", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kandelo-exec-malformed-wasm-"));
    const malformedWasm = join(tempDir, "malformed.wasm");
    try {
      // Valid Wasm magic/version with a truncated type section. This reaches
      // compilation, which must fail before kernelExecCommit discards the old
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

  it.skipIf(!hasVforkLifecycle)(
    "kills a committed vfork child when Node replacement Worker construction fails",
    async () => {
      const injection = "KANDELO_TEST_EXEC_WORKER_CONSTRUCTION_FAILURE";
      const previousInjection = process.env[injection];
      process.env[injection] = "once";
      try {
        const result = await runCentralizedProgram({
          programPath: vforkLifecycleBinary!,
          argv: ["vfork-lifecycle-node-postcommit-fatal"],
          execPrograms: new Map([
            ["/bin/vfork-exec-child", execChildBinary!],
          ]),
          useDefaultRootfs: false,
          timeout: 20_000,
        });

        // The parent resumes through the fatal-child edge, then deliberately
        // exits 5 because the committed child died from SIGSEGV instead of the
        // fixture's expected status 42.
        expect(result.exitCode).toBe(5);
        expect(result.stdout).toContain("PARENT_AFTER_EXEC_COMMIT");
        expect(result.stdout).not.toContain("argc=2");
        expect(result.stdout).not.toContain("PARENT_REAPED_EXEC_CHILD");
        expect(result.stdout).not.toContain("PASS: VFORK_LIFECYCLE");
        expect(result.hostDiagnostics).toEqual([
          expect.objectContaining({
            source: "exec post-commit transition",
            status: 139,
            message: expect.stringContaining(
              "injected exec Worker construction failure",
            ),
          }),
        ]);
      } finally {
        if (previousInjection === undefined) delete process.env[injection];
        else process.env[injection] = previousInjection;
      }
    },
  );
});
