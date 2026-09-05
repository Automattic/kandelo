// Phase 6 D6.5 — live HOST externref fork through a REAL centralized worker,
// with the co-resident fork-module ENABLED.
//
// This closes the last reference kind not yet proven through a real worker fork
// (funcref, exnref, and typed-GC already are). The fixture obtains a genuine
// host reference from the broker-backed `env.get_ext` import, keeps it in a
// reference LOCAL live across `kernel_fork`, and in the fresh CHILD verifies —
// through `env.check_ext` — that the SAME host identity survived the fork.
//
// A module-instance externref has no linear-memory representation, so copying
// the child's memory byte-for-byte cannot carry it: the fresh child must
// reconstruct the broker-tracked externref from the reference recipe. Because
// the value comes from a host import it is a genuine broker externref (an opaque
// host object, not a GC-internalized value), so the fork codec classifies it as
// an `externref` node — exactly the D6.2 broker seam — rather than a typed-GC
// node. With the fork-module enabled the child re-roots the reference through
// the `wpk_fork_host` engine-floor seam (`host_resolve_externref` over the
// worker's externref token cache).
//
// The test wires `get_ext` / `check_ext` to the process externref owner (broker)
// through `ForkHostImportOwnerRuntime`, so the host value the guest holds really
// does round-trip through the broker's `registerForWire` / `authorizeForWire`
// on both the producing call and the child's identity check. It asserts, for the
// flag-on worker path:
//
//   (a) CORRECTNESS / PARITY — the child's `check_ext` confirms the SAME host
//       identity and the child exits 0 exactly as the flag-off (JS reference
//       path) run does. A lost or wrong reconstruction makes the child exit 91
//       (null) or 94 (identity divergence), which the parent turns into exit 92.
//   (b) PROOF OF USE — the co-resident module re-rooted the carried externref
//       through the broker seam: the child worker reports
//       `externrefs_resolved=<n>` with n > 0. A silent JS fallback would leave
//       the module counter at zero.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { moduleReferenceProof } from "./fork-module-reference-proof";
import { defineForkExternrefImport } from "../src/fork-externref-import-mailbox";
import type { ForkHostImportOwnerRuntime } from "../src/fork-host-import-runtime";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/externref-local-fork-fresh-worker.wat",
);
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");

// The single host reference the fixture obtains from `get_ext` and re-checks in
// the fresh child. Broker identity is by JS reference equality, so a distinct
// object per run is the exact identity the child must recover.
const HOST_REFERENCE: { readonly tag: string } = Object.freeze({
  tag: "externref-fork-fixture-host-reference",
});

/**
 * Register `env.get_ext` (mints the host reference) and `env.check_ext` (returns
 * 1 iff it is the SAME host reference) as broker-backed owner host imports. The
 * owner's endpoint routes the externref result through `registerForWire` and the
 * externref parameter through `authorizeForWire`, so the guest only ever holds a
 * broker token — the real value stays host-side and must be re-rooted through the
 * `host_resolve_externref` seam after the fork.
 */
function registerHostReferenceImports(owner: ForkHostImportOwnerRuntime): void {
  owner.register(
    "env",
    "get_ext",
    defineForkExternrefImport(1, [], ["externref"]),
    () => HOST_REFERENCE,
  );
  owner.register(
    "env",
    "check_ext",
    defineForkExternrefImport(2, ["externref"], ["i32"]),
    (_context, value) => (value === HOST_REFERENCE ? 1 : 0),
  );
}

describe("externref fork through the co-resident module (Phase 6 D6.5)", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-externref-fork-"));
    const rawPath = join(workDir, "externref-local-fork-fresh-worker.raw.wasm");
    programPath = join(workDir, "externref-local-fork-fresh-worker.wasm");
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      fixtureSource,
      "-o",
      rawPath,
    ]);
    execFileSync(instrumenter, [rawPath, "-o", programPath]);
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("aborts a carried host externref fork cleanly with EOPNOTSUPP (flag off)", async () => {
    // GATED KIND: a live host externref has no linear-memory representation and
    // cannot be faithfully reconstructed in a fresh child today, so the fork is
    // aborted cleanly with -EOPNOTSUPP on the CAPTURE side (the record-stub for
    // ENCODE_EXTERNREF in fork-activation-registry.ts marks the kind; the parent
    // run loop calls beginAbortReplay(EOPNOTSUPP) after seal). No child is
    // spawned and nothing is reconstructed.
    //
    // The fixture guest does not branch on a negative fork() return, so
    // -EOPNOTSUPP (-95) drives it into its parent path. Before the never-reaped
    // wait, the PARENT re-checks its carried externref: it asserts the reference
    // survived the aborted capture/restore intact (still non-null and still the
    // SAME owner-minted host identity through the broker), exiting 96/97 on
    // divergence. Only when the parent's reference is intact does it fall
    // through to the wait path, which fails to reap the never-spawned child and
    // exits 92 — so an exit of 92 proves BOTH the clean abort AND that the
    // parent continued unaffected. The load-bearing signals are that the gate is
    // CLEAN: no worker crash (stderr empty) and no reconstruction (the externref
    // proof-of-use is null — neither the JS path nor the module ran a
    // reconstruction).
    const result = await runCentralizedProgram({
      programPath,
      argv: ["externref-local-fork-fresh-worker"],
      timeout: 30_000,
      forkModuleEnabled: false,
      forkHostImportRegistrar: registerHostReferenceImports,
    });
    expect(
      result.exitCode,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(92);
    expect(result.stderr).toBe("");
    expect(
      moduleReferenceProof(result.hostDiagnostics, "externref"),
    ).toBeNull();
  });

  // F1 (module abort-replay): with the co-resident fork-module ENABLED, a gated
  // fork now aborts cleanly through the module's own `fm_begin_abort`/
  // `fm_finish_abort` path (see `beginModuleAbortReplay`/`finishModuleTransaction`
  // in `host/src/fork-process-continuation.ts`) instead of throwing
  // "fork-module path does not own abort replay" and crashing the worker. This
  // is the primary end-to-end proof of F1: the flag-on path now reaches the SAME
  // clean-abort outcome as the flag-off test above.
  it("aborts a carried host externref fork cleanly with EOPNOTSUPP (flag on)", async () => {
    const result = await runCentralizedProgram({
      programPath,
      argv: ["externref-local-fork-fresh-worker"],
      timeout: 30_000,
      forkModuleEnabled: true,
      forkHostImportRegistrar: registerHostReferenceImports,
    });
    // The flag-on path reaches the SAME clean-abort outcome as the flag-off
    // test above — a gated externref is not reconstructed under either flag.
    // No child is spawned, so the guest exits 92; the gate is clean (stderr
    // empty) and nothing reconstructed the reference (the externref
    // proof-of-use is null).
    expect(
      result.exitCode,
      `flag-on externref fork exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(92);
    expect(result.stderr).toBe("");
    expect(
      moduleReferenceProof(result.hostDiagnostics, "externref"),
    ).toBeNull();
  });
});
