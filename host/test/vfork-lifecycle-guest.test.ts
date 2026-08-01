import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { tryResolveBinary } from "../src/binary-resolver";
import {
  detectPtrWidth,
  extractHeapBase,
  WASM_PAGE_SIZE,
} from "../src/constants";
import { computeProcessMemoryLayout } from "../src/process-memory";
import { runCentralizedProgram } from "./centralized-test-helper";

const lifecycleProgram = tryResolveBinary("programs/vfork-lifecycle.wasm");
const threadProgram = tryResolveBinary("programs/vfork-from-thread.wasm");
const fatalProgram = tryResolveBinary("programs/vfork-fatal-lifecycle.wasm");
const externalSignalProgram = tryResolveBinary(
  "programs/vfork-external-signal.wasm",
);
const stateProgram = tryResolveBinary("programs/vfork-posix-state.wasm");
const execChild = tryResolveBinary("programs/exec-child.wasm");

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

function expectOrdered(output: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = output.indexOf(marker);
    expect(index, `missing output marker ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("production vfork lifecycle", () => {
  it.skipIf(!lifecycleProgram || !execChild)(
    "keeps the parent parked through exit and failed exec, then releases on exec",
    async () => {
      const events: string[] = [];
      const result = await runCentralizedProgram({
        programPath: lifecycleProgram!,
        argv: ["vfork-lifecycle"],
        execPrograms: new Map([
          ["/bin/vfork-exec-child", execChild!],
        ]),
        useDefaultRootfs: false,
        timeout: 15_000,
        onProcessEvent: (event) => events.push(event.kind),
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expectOrdered(result.stdout, [
        "CHILD_EXIT_ONE",
        "PARENT_RESUME_ONE",
        "CHILD_EXIT_TWO",
        "PARENT_RESUME_TWO",
        "CHILD_FAILED_EXEC",
        "PARENT_AFTER_FAILED_EXEC_EXIT",
        "CHILD_NESTED_FORK_EAGAIN",
        "CHILD_NESTED_VFORK_EAGAIN",
        "CHILD_PTHREAD_EAGAIN",
        "PARENT_AFTER_REJECTED_OWNERSHIP",
        "PARENT_AFTER_EXEC_COMMIT",
        "PARENT_REAPED_EXEC_CHILD",
        "PASS: VFORK_LIFECYCLE",
      ]);
      expect(events).toContain("exec");
    },
  );

  it.skipIf(!threadProgram)(
    "parks a pthread caller while its sibling and child use independent channels",
    async () => {
      const result = await runCentralizedProgram({
        programPath: threadProgram!,
        argv: ["vfork-from-thread"],
        useDefaultRootfs: false,
        timeout: 15_000,
        // WHY: this budget admits exactly the parent's initial address space.
        // pthread creation grows it before vfork, so any attempted child
        // allocation would sample an already-exhausted budget and fail. A
        // passing child therefore used the parent's existing Memory alias.
        maxProcessMemoryBytes: initialAddressSpaceBytes(threadProgram!),
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expectOrdered(result.stdout, [
        "THREAD_BEFORE_VFORK",
        "MAIN_SIBLING_RAN",
        "MAIN_RELEASED_CHILD",
        "CHILD_THREAD_EXIT",
        "THREAD_CALLER_RESUMED",
        "MAIN_JOINED_CALLER",
        "MAIN_REAPED_CHILD",
        "PASS: VFORK_FROM_THREAD",
      ]);
    },
  );

  it.skipIf(!fatalProgram)(
    "releases the parent after exact trap and signal teardown",
    async () => {
      const result = await runCentralizedProgram({
        programPath: fatalProgram!,
        argv: ["vfork-fatal-lifecycle"],
        useDefaultRootfs: false,
        timeout: 15_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expectOrdered(result.stdout, [
        "CHILD_BEFORE_TRAP",
        "PARENT_AFTER_TRAP",
        "PARENT_REAPED_TRAP",
        "CHILD_BEFORE_SIGKILL",
        "PARENT_AFTER_SIGKILL",
        "PARENT_REAPED_SIGKILL",
        "PASS: VFORK_FATAL_LIFECYCLE",
      ]);
      expect(result.hostDiagnostics).toHaveLength(1);
      expect(result.hostDiagnostics[0]).toMatchObject({
        status: 132,
        source: "worker-main error message",
      });
      expect(result.hostDiagnostics[0].message).toMatch(/unreachable/i);
    },
  );

  it.skipIf(!externalSignalProgram)(
    "contains a compute-running borrower after an external fatal signal",
    async () => {
      const result = await runCentralizedProgram({
        programPath: externalSignalProgram!,
        argv: ["vfork-external-signal"],
        useDefaultRootfs: false,
        timeout: 15_000,
      });

      expect(result.exitCode, result.stderr).toBe(139);
      expect(result.stderr).toBe("");
      expectOrdered(result.stdout, [
        "VFORK_EXTERNAL_SIGNAL_BEGIN",
        "KILLER_THREAD_READY",
        "CHILD_COMPUTE_LOOP",
        "KILLER_SENT_SIGKILL",
      ]);
      expect(result.stdout).not.toContain("UNSAFE_PARENT_RESUMED");
      expect(result.hostDiagnostics).toHaveLength(1);
      expect(result.hostDiagnostics[0]).toMatchObject({
        status: 139,
        source: "vfork address-space containment",
      });
      expect(result.hostDiagnostics[0].message).toMatch(
        /ambiguous child teardown/,
      );
    },
    20_000,
  );

  it.skipIf(!stateProgram)(
    "preserves independent POSIX state and shared open-file descriptions",
    async () => {
      const result = await runCentralizedProgram({
        programPath: stateProgram!,
        argv: ["vfork-posix-state"],
        timeout: 15_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expectOrdered(result.stdout, [
        "PARENT_AFTER_STATE_CHILD",
        "PARENT_REAPED_STATE_CHILD",
        "PASS: VFORK_POSIX_STATE",
      ]);
    },
  );
});
