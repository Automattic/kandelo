// Constructor provenance through a real process Worker: Wasm-GC objects whose
// ONLY construction path is their constructor survive fork().
//
// An immutable Wasm-GC array cannot be filled after allocation, and Wasm has no
// instruction that builds one of runtime length from arbitrary values. A fork
// child is a fresh instance, so the only faithful rebuild is re-running the
// allocation instruction that made the array with operands that reproduce it.
// `array.new_fixed`, `array.new` and `array.new_default` operands are the
// array's own contents; an `array.new_elem` array's elements are its segment's
// items, which the capture matches; an `array.new_data` run's operands are not
// visible in the array, so the co-resident fork module records each distinct
// run, with a hash of its contents, where the instruction runs
// (docs/fork-reference-support.md, "Constructor provenance").
//
// The fixture is the native host's (`crates/host-native/fixtures/
// native_fork_gc_provenance.wat`, `smoke_fork_gc_provenance_reconstructs`):
// one source, three hosts. It drops every segment before forking, forks twice
// from the parent and once from the first child, and checks every object in
// every process itself; see its header for the exit codes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";

const testDir = dirname(fileURLToPath(import.meta.url));
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");
const fixtureSource = resolve(
  testDir,
  "../../crates/host-native/fixtures/native_fork_gc_provenance.wat",
);

describe("constructor-only Wasm-GC objects in a fresh process Worker", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-provenance-"));
    const rawPath = join(workDir, "gc-provenance.raw.wasm");
    programPath = join(workDir, "gc-provenance.wasm");
    // wasm-tools, not WABT's wat2wasm: WABT cannot assemble Wasm-GC types.
    execFileSync("wasm-tools", ["parse", fixtureSource, "-o", rawPath]);
    execFileSync(instrumenter, ["--stamp-abi-version", rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("rebuilds them by re-running their constructors, in children and a grandchild", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-provenance"],
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `a rebuilt object failed its check (see the fixture's exit codes; 90 = ` +
        `the parent's fork was refused)\nstdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    // No fork was aborted: a refusal would have been reported here. That
    // every fork produced a child the fixture checks itself: it exits 90/91
    // when fork() fails and 92 when a child cannot be reaped.
    expect(result.hostDiagnostics.filter((d) => d.source === "fork")).toEqual([]);
    const gcNodes = moduleReferenceProof(result.forkModuleDiagnostics, "gc");
    expect(gcNodes, "the module did not admit a GC reconstruction").not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});

// Recording a run keeps a small record, never the array. A guest makes 4,096
// distinct `array.new_data` runs of 16 KiB each (64 MiB of array contents,
// 1,024 pages' worth) and keeps none of them but the last; the fork module's
// run table is the only thing recording adds to the process's memory, and the
// guest measures its own linear memory across the loop. The last array must
// still be rebuilt in a child, from its record.
const MANY_RUNS = 4096;
const RUN_BYTES = 16 * 1024;
const RUN_STRIDE = 4;

function manyRunsWat(): string {
  const segmentBytes = (MANY_RUNS - 1) * RUN_STRIDE + RUN_BYTES;
  let segment = "";
  for (let index = 0; index < segmentBytes; index++) {
    segment += `\\${(index % 251).toString(16).padStart(2, "0")}`;
  }
  const lastOffset = (MANY_RUNS - 1) * RUN_STRIDE;
  return `
(module
  (import "env" "memory" (memory 1 16384 shared))
  (import "env" "__channel_base" (global $__channel_base (mut i32)))
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (import "kernel" "kernel_exit" (func $kernel_exit (param i32)))
  (type $bytes (array i8))
  (data $seg "${segment}")
  (global $__stack_pointer (export "__stack_pointer") (mut i32) (i32.const 65536))
  (global (export "__heap_base") i32 (i32.const 65536))
  (func (export "__abi_version") (result i32) i32.const 44)
  (func $syscall (param $nr i32) (param $a0 i64) (param $a1 i64)
    (local $base i32)
    (local.set $base (global.get $__channel_base))
    (i32.store offset=4 (local.get $base) (local.get $nr))
    (i64.store offset=8 (local.get $base) (local.get $a0))
    (i64.store offset=16 (local.get $base) (local.get $a1))
    (i64.store offset=24 (local.get $base) (i64.const 0))
    (i64.store offset=32 (local.get $base) (i64.const 0))
    (i64.store offset=40 (local.get $base) (i64.const 0))
    (i64.store offset=48 (local.get $base) (i64.const 0))
    (i32.atomic.store (local.get $base) (i32.const 1))
    (drop (memory.atomic.notify (local.get $base) (i32.const 1)))
    (loop $wait
      (drop (memory.atomic.wait32 (local.get $base) (i32.const 1) (i64.const -1)))
      (br_if $wait (i32.eq (i32.atomic.load (local.get $base)) (i32.const 1))))
    (i32.atomic.store (local.get $base) (i32.const 0)))
  (func $exit (param $code i32)
    ;; SYS_EXIT_GROUP, then leave as musl's _Exit does on this host.
    (call $syscall (i32.const 387) (i64.extend_i32_s (local.get $code)) (i64.const 0))
    (call $kernel_exit (local.get $code))
    unreachable)
  (func (export "_start")
    (local $i i32) (local $a (ref null $bytes)) (local $before i32)
    (local $grown i32) (local $pid i32)
    (local.set $before (memory.size))
    (block $done
      (loop $each
        (br_if $done (i32.ge_u (local.get $i) (i32.const ${MANY_RUNS})))
        (local.set $a (array.new_data $bytes $seg
          (i32.mul (local.get $i) (i32.const ${RUN_STRIDE})) (i32.const ${RUN_BYTES})))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $each)))
    (local.set $grown (i32.sub (memory.size) (local.get $before)))
    data.drop $seg
    (local.set $pid (call $kernel_fork (i32.const 0)))
    (if (i32.lt_s (local.get $pid) (i32.const 0)) (then (call $exit (i32.const 250))))
    (if (i32.eqz (local.get $pid))
      (then
        ;; The last run read the segment from ${lastOffset}.
        (if (i32.or
              (i32.ne (array.len (ref.as_non_null (local.get $a))) (i32.const ${RUN_BYTES}))
              (i32.ne (array.get_u $bytes (local.get $a) (i32.const 0))
                      (i32.const ${lastOffset % 251})))
          (then (call $exit (i32.const 251))))
        (call $exit (i32.const 0))))
    ;; Reap the child (SYS_wait4, status at 1024); its failure is ours.
    (call $syscall (i32.const 139) (i64.extend_i32_s (local.get $pid)) (i64.const 1024))
    (if (i32.load (i32.const 1024)) (then (call $exit (i32.const 252))))
    ;; Report the pages the loop grew linear memory by.
    (call $exit (local.get $grown))))
`;
}

describe("recording runs keeps records, not arrays", () => {
  let workDir = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-provenance-runs-"));
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("grows memory by the run table, not by the arrays, and still rebuilds the last", async () => {
    const source = join(workDir, "many-runs.wat");
    const rawPath = join(workDir, "many-runs.raw.wasm");
    const programPath = join(workDir, "many-runs.wasm");
    writeFileSync(source, manyRunsWat());
    execFileSync("wasm-tools", ["parse", source, "-o", rawPath]);
    execFileSync(instrumenter, ["--stamp-abi-version", rawPath, "-o", programPath]);

    const result = await runCentralizedProgram({
      programPath,
      argv: ["many-runs"],
      timeout: 120_000,
      useDefaultRootfs: false,
    });
    // 250 = the fork was refused, 251 = the child's array was wrong, 252 =
    // the child failed; anything below is the pages the loop grew.
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBeLessThan(250);
    // 4,096 runs end in an 8,192-entry table: 320 KiB, five pages. Each
    // doubling maps the new table before it returns the old one, and linear
    // memory never shrinks, so the loop grows memory by up to about twice
    // that. The arrays' contents would be 1,024 pages.
    expect(result.exitCode, "pages the loop grew linear memory by").toBeLessThanOrEqual(16);
    expect(result.hostDiagnostics.filter((d) => d.source === "fork")).toEqual([]);
  });
});
