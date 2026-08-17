import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import {
  detectPtrWidth,
  extractHeapBase,
  WASM_PAGE_SIZE,
} from "../../../../host/src/constants";
import { computeProcessMemoryLayout } from "../../../../host/src/process-memory";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import {
  RUBY_PRIVILEGED_FORK_MARKER,
  RUBY_PRIVILEGED_FORK_PROGRAM,
  RUBY_VFORK_EXEC_MARKER,
  RUBY_VFORK_EXEC_PROGRAM,
  RUBY_VFORK_EXECUTABLE,
  RUBY_VFORK_FAILED_EXEC_MARKER,
  RUBY_VFORK_FAILED_EXEC_PROGRAM,
} from "./posix-spawn-contract";

const rubyBinary = tryResolveBinary("programs/ruby/ruby.wasm");
const execChildBinary = tryResolveBinary("programs/exec-child.wasm");

function initialAddressSpaceBytes(programPath: string): number {
  const file = readFileSync(programPath);
  const bytes = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  );
  const ptrWidth = detectPtrWidth(bytes);
  return computeProcessMemoryLayout({
    ptrWidth,
    programBytes: bytes,
    heapBase: extractHeapBase(bytes),
  }).initialPages * WASM_PAGE_SIZE;
}

describe.skipIf(!rubyBinary || !execChildBinary)(
  "Ruby Process.spawn on Kandelo",
  () => {
    it(`${RUBY_VFORK_FAILED_EXEC_MARKER} preserves process semantics`, async () => {
      const events: string[] = [];
      const result = await runCentralizedProgram({
        programPath: rubyBinary!,
        argv: ["ruby", "--disable-gems", "-e", RUBY_VFORK_FAILED_EXEC_PROGRAM],
        env: ["HOME=/tmp", "TMPDIR=/tmp"],
        uid: 1000,
        gid: 1000,
        // WHY: this admits the initial Ruby address space and nothing else.
        // An ordinary fork would need a second full Memory and fail before it
        // could report ENOENT. Reaching the failed exec proves CRuby selected
        // Kandelo's borrowed-memory vfork transaction.
        maxProcessMemoryBytes: initialAddressSpaceBytes(rubyBinary!),
        captureForkCount: true,
        onProcessEvent: (event) => events.push(event.kind),
        useDefaultRootfs: false,
        timeout: 180_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`${RUBY_VFORK_FAILED_EXEC_MARKER}\n`);
      expect(result.hostDiagnostics).toEqual([]);
      expect(result.forkCountSamples).toEqual([1n]);
      expect(events).toEqual(["spawn", "spawn", "exit", "exit"]);
    }, 240_000);

    it(`${RUBY_VFORK_EXEC_MARKER} preserves process semantics`, async () => {
      const events: string[] = [];
      const result = await runCentralizedProgram({
        programPath: rubyBinary!,
        argv: ["ruby", "--disable-gems", "-e", RUBY_VFORK_EXEC_PROGRAM],
        env: ["HOME=/tmp", "TMPDIR=/tmp"],
        uid: 1000,
        gid: 1000,
        execPrograms: new Map([
          [RUBY_VFORK_EXECUTABLE, execChildBinary!],
        ]),
        captureForkCount: true,
        onProcessEvent: (event) => events.push(event.kind),
        useDefaultRootfs: false,
        timeout: 180_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("argv[0]=ruby-vfork-child\n");
      expect(result.stdout).toContain("FROM=ruby-upstream-vfork\n");
      expect(result.stdout).toContain(`${RUBY_VFORK_EXEC_MARKER}\n`);
      expect(result.hostDiagnostics).toEqual([]);
      expect(result.forkCountSamples).toEqual([1n]);
      expect(events).toEqual(["spawn", "spawn", "exec", "exit", "exit"]);
    }, 240_000);

    it(`${RUBY_PRIVILEGED_FORK_MARKER} preserves process semantics`, async () => {
      const events: string[] = [];
      const result = await runCentralizedProgram({
        programPath: rubyBinary!,
        argv: ["ruby", "--disable-gems", "-e", RUBY_PRIVILEGED_FORK_PROGRAM],
        env: ["HOME=/tmp", "TMPDIR=/tmp"],
        uid: 0,
        gid: 0,
        // Root is intentionally in CRuby's privileged ordinary-fork branch.
        // With no room for a cloned Memory, both its initial attempt and the
        // documented post-GC retry fail with ENOMEM.
        maxProcessMemoryBytes: initialAddressSpaceBytes(rubyBinary!),
        onProcessEvent: (event) => events.push(event.kind),
        useDefaultRootfs: false,
        timeout: 180_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`${RUBY_PRIVILEGED_FORK_MARKER}\n`);
      expect(result.hostDiagnostics).toEqual([]);
      expect(events).toEqual(["spawn", "spawn", "spawn", "exit"]);
    }, 240_000);
  },
);
