// P4 (Path-B flip completion) — module-mode GATED-abort parity on V8.
//
// This is the Node/V8 mate of native's
// `crates/host-native/src/lib.rs::smoke_fork_gated_externref_parent_survives`,
// and it closes the module-mode gated-ABORT end-to-end coverage that P3b's
// review explicitly deferred to P4 (Finding D: "module-mode gated-ABORT
// end-to-end on V8 is not exercised in P3b").
//
// The one intended `EOPNOTSUPP` boundary — a live host externref carried
// across `kernel_fork` with NO recorded mint-time provenance — must, with the
// co-resident fork MODULE enabled (`forkModuleEnabled: true`), abort the fork
// cleanly THROUGH THE MODULE'S OWN continuation-journal abort path
// (`beginAbortReplay` -> `beginModuleAbortReplay` -> the coarse `fm_parent_abort`
// per-phase entry), NOT
// the JS reconstruction engine (which P6 deletes). The claim proven here:
//
//   * the fork returns EXACTLY -EOPNOTSUPP (the fixture asserts pid == -95 and
//     exits 92 otherwise), so no child is spawned (0 = child, positive = real
//     child would both fail the fixture's own guard);
//   * the PARENT survives unaffected — its externref local still resolves to
//     the SAME owner-minted host identity after the aborted fork (the fixture
//     exits 93/94 on a null/divergent parent reference), so a clean exit 0 is
//     the parent-survival proof;
//   * there is NO ~30s pump/gate hang: the run completes well under a bounded
//     wall-clock budget. This guards the ledger's gate-hang regression (native
//     root cause: the gated-abort branch used to drive `fm_build_gc_plan`
//     against the sealed placeholder graph). The bounded assertion is against
//     an explicit budget, NOT the 30s test timeout, so a re-introduced hang
//     fails loud with a clear message instead of a timeout artifact.
//
// The fixture mints its externref via `call_indirect` so the fork-instrument
// provenance-wrapper pass (which rewrites only DIRECT calls) records nothing —
// the exact mechanism native uses to still reach the gate after the capture
// short-circuit landed. See the fixture's own doc comment.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { defineForkExternrefImport } from "../src/fork-externref-import-mailbox";
import type { ForkHostImportOwnerRuntime } from "../src/fork-host-import-runtime";
import type { HostDiagnostic } from "../src/host-diagnostic";

// Positive proof-of-use reader: the parent worker reports how many frames the
// co-resident module committed for its fork (the worker-tail
// `fork_module_frames` diagnostic). A nonzero count for a gated fork proves the
// module's OWN abort path drove this fork's unwind — a silent JS fallback never
// constructs the backend and emits nothing (returns null here).
function forkModuleFramesCommitted(
  hostDiagnostics: readonly HostDiagnostic[],
): number | null {
  for (const diagnostic of hostDiagnostics) {
    if (diagnostic.source !== "fork-module") continue;
    const match = /fork_module_frames=(\d+)/.exec(diagnostic.message);
    if (match) return Number(match[1]);
  }
  return null;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(
  testDir,
  "fixtures/externref-gated-indirect-fork-fresh-worker.wat",
);
const instrumenter = resolve(testDir, "../../tools/bin/wasm-fork-instrument");

// The single host reference the fixture mints (via the broker) and re-checks
// in the surviving parent. Broker identity is by JS reference equality, so a
// distinct object per run is the exact identity the parent must still resolve
// to after the aborted fork.
const HOST_REFERENCE: { readonly tag: string } = Object.freeze({
  tag: "externref-gated-fork-fixture-host-reference",
});

// A generous wall-clock budget for the whole run. This is NOT the 30s hang the
// test guards against — a healthy gated fork completes in well under this — but
// it is comfortably below the vitest `timeout` so a re-introduced pump hang
// surfaces as a clear assertion failure, not an opaque timeout.
const BOUNDED_WALL_CLOCK_MS = 20_000;

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

describe("externref minted through call_indirect survives the fork", () => {
  let workDir = "";
  let programPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "kandelo-externref-gated-fork-"));
    const rawPath = join(
      workDir,
      "externref-gated-indirect-fork-fresh-worker.raw.wasm",
    );
    programPath = join(
      workDir,
      "externref-gated-indirect-fork-fresh-worker.wasm",
    );
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

  it("completes the fork, the child holds the same host identity, and there is no hang", async () => {
    const started = Date.now();
    const result = await runCentralizedProgram({
      programPath,
      argv: ["externref-gated-indirect-fork-fresh-worker"],
      timeout: 30_000,
      forkHostImportRegistrar: registerHostReferenceImports,
    });
    const elapsed = Date.now() - started;

    expect(
      result.exitCode,
      "the fork completed and both sides held the owner identity\n"
        + `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`
        + `host:\n${result.hostDiagnostics.map((d) => d.message).join("\n")}`,
    ).toBe(0);
    expect(result.stderr).toBe("");

    // NOT REFUSED. This is the claim that replaced the gate: a reference the
    // provenance-wrapper pass never saw is still a broker reference, and the
    // module can now name it. A `fork aborted` diagnostic here means the
    // refusal came back by another route.
    const aborts = result.hostDiagnostics.filter((diagnostic) =>
      diagnostic.message.includes("fork aborted")
    );
    expect(aborts, "no abort diagnostic").toEqual([]);

    // The ledger's gate-hang regression: a healthy fork completes well under
    // this, and the budget is comfortably below the vitest timeout so a
    // re-introduced pump hang fails loud instead of as a timeout artifact.
    expect(
      elapsed,
      `fork took ${elapsed}ms, over the ${BOUNDED_WALL_CLOCK_MS}ms budget`,
    ).toBeLessThan(BOUNDED_WALL_CLOCK_MS);
  });
});
