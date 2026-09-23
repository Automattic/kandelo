// Externref stage E2: a fork that carries a live raw HOST externref is refused
// with EOPNOTSUPP, through a real process Worker -- and an `extern.convert_any`
// view of the program's own Wasm-GC object is NOT a host object and still
// forks.
//
// WHY THE BOUNDARY. A fork child runs in a fresh Worker, and a host object
// cannot be copied into it with its identity intact. A capability a guest needs
// across fork belongs behind a kernel object -- an fd or a device -- which fork
// already shares with POSIX semantics. So fork keeps Wasm-GC and static-root
// references and refuses raw host externrefs, on every host
// (docs/fork-reference-support.md). The refusal is made by the co-resident
// fork module at capture (`__wpk_fork_ref_gc_broker_encode`'s fall-through),
// latched, and reported when the capture seals; the worker's seal-failure path
// replays the parent and `fork()` returns -EOPNOTSUPP with no child.
//
// WHAT EACH FIXTURE CHECKS FOR ITSELF, in the guest (see its header for the
// exit codes): fork() returned exactly -95; no child ran; the KERNEL reports no
// child (wait4(-1, WNOHANG) fails ECHILD); and the parent still holds the SAME
// host object, read back by identity through the test import. What this file
// adds is the host's side: the abort was reported with errno 95, and the
// kernel never counted a fork.
//
// The host object comes from a plain local host import the test supplies
// (`fixtures/host-object-import-worker-entry.ts`); no production import hands
// a guest a raw host externref. That entry forces the helper's main-thread
// kernel, because the kernel worker's own worker adapter always launches the
// production entry. The GC-view case imports nothing extra and runs on the
// production kernel-worker path.
//
// The native mate is `smoke_fork_host_externref_refused` in
// `crates/host-native/src/lib.rs`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";

const testDir = dirname(fileURLToPath(import.meta.url));
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");
const hostObjectEntry = pathToFileURL(
  resolve(testDir, "fixtures/host-object-import-worker-entry.ts"),
);

const EOPNOTSUPP = 95;

/** Assemble a GC-capable `.wat` with wasm-tools and fork-instrument it. */
function buildFixture(workDir: string, name: string): string {
  const rawPath = join(workDir, `${name}.raw.wasm`);
  const programPath = join(workDir, `${name}.wasm`);
  // wasm-tools, not WABT's wat2wasm: WABT cannot assemble Wasm-GC types.
  execFileSync("wasm-tools", [
    "parse",
    resolve(testDir, `fixtures/${name}.wat`),
    "-o",
    rawPath,
  ]);
  // The fixtures declare a placeholder __abi_version; stamp the running ABI
  // at instrumentation time (test-only flag), as catch-ref-fresh-worker does.
  execFileSync(instrumenter, ["--stamp-abi-version", rawPath, "-o", programPath]);
  return programPath;
}

describe("a fork that holds a raw host externref is refused with EOPNOTSUPP", () => {
  let workDir = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-host-externref-refusal-"));
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  for (const [name, where] of [
    ["host-externref-fork-refused-local", "a local"],
    ["host-externref-fork-refused-struct-field", "a Wasm-GC struct field"],
  ] as const) {
    it(`refuses the fork when the host object is held in ${where}, and the parent continues`, async () => {
      const result = await runCentralizedProgram({
        programPath: buildFixture(workDir, name),
        argv: [name],
        timeout: 30_000,
        useDefaultRootfs: false,
        processWorkerEntry: hostObjectEntry,
        captureForkCount: true,
      });

      expect(
        result.exitCode,
        `the guest's own checks failed (see the fixture's exit codes)\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);

      // The host side of the same boundary: the worker reported the abort with
      // the refusal's errno -- not a later validation's EINVAL, not a trap.
      const aborts = result.hostDiagnostics.filter((d) => d.source === "fork");
      expect(aborts, "exactly one fork was aborted").toHaveLength(1);
      expect(aborts[0]!.message).toMatch(
        new RegExp(`^fork aborted with errno=${EOPNOTSUPP}: `),
      );

      // And the kernel never created a child: a refused fork never asks it.
      expect(result.forkCount, "the kernel counted no fork").toBe(0n);
    });
  }
});

describe("an extern.convert_any view of the program's own GC object still forks", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-gc-view-externref-fork-"));
    programPath = buildFixture(workDir, "gc-view-externref-fork-fresh-worker");
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("reconstructs the viewed struct in a fresh child through the module", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["gc-view-externref-fork-fresh-worker"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(
      result.exitCode,
      `GC-view fork exited unexpectedly (95 = the view was refused as a host ` +
        `object)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      result.hostDiagnostics.filter((d) => d.source === "fork"),
      "no fork was aborted",
    ).toEqual([]);

    // The child rebuilt the viewed struct through the module's typed-GC path.
    const gcNodes = moduleReferenceProof(result.forkModuleDiagnostics, "gc");
    expect(
      gcNodes,
      "expected a fork-module typed-GC proof-of-use diagnostic from the child",
    ).not.toBeNull();
    expect(gcNodes!).toBeGreaterThan(0);
  });
});
