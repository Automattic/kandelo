// The staging slab must hold the largest activation admission the programs this
// repo builds actually make.
//
// `STAGING_SLAB_BYTES` (`host/src/fork-module-instance.ts`) is sized from a
// measurement of the shipped artifacts, and a measurement written into a
// comment is a snapshot: the next php build with a bigger `intl.so` would make
// it wrong, and the failure would be "staging slab exhausted" at a `dlopen`
// inside a forking program, an hour and a package build away from the cause.
// This test re-measures the built artifacts against the live slab, in the
// same shape as `fork-identity-capacity.test.ts`, so the number fails HERE.
//
// WHAT IS MEASURED: what `ForkModuleContinuationBackend` stages, per
// activation. Since lane F stage 1b that is one thing: the activation's `KFAA`
// admission descriptor, written by the production writer
// (`encodeForkAdmission`) -- header, section refs and every
// `kandelo.wpk_fork.*` section verbatim. The slab is a per-call scratch, so the
// bound is the LARGEST admission across every artifact, not their sum.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { encodeForkAdmission } from "../src/fork-guest-sections";

/** Every built program artifact, recursively, if any tier has been built. */
function builtArtifacts(): { name: string; bytes: Uint8Array }[] {
  const roots = [
    join(import.meta.dirname, "..", "..", "local-binaries", "source-only-v1", "programs", "wasm32"),
    join(import.meta.dirname, "..", "..", "local-binaries", "programs", "wasm32"),
  ];
  const out: { name: string; bytes: Uint8Array }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        // Test scratch directories carry no program a process would run.
        if (!entry.startsWith("binary-resolver-test-")) walk(path, `${prefix}${entry}/`);
      } else if (entry.endsWith(".wasm") || entry.endsWith(".so")) {
        out.push({ name: `${prefix}${entry}`, bytes: readFileSync(path) });
      }
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, "");
    if (out.length > 0) return out;
  }
  return out;
}

/** The bytes one artifact's admission stages, or null if it is not fork-instrumented. */
function admissionBytes(bytes: Uint8Array): number | null {
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof WebAssembly.CompileError) return null;
    throw error;
  }
  // A module with no resume catalog is not fork-instrumented and is never
  // admitted; the module refuses an admission without one.
  if (WebAssembly.Module.customSections(module, "kandelo.wpk_fork.resume_catalog").length === 0) {
    return null;
  }
  return encodeForkAdmission(0, 0, new Uint8Array(32), module).length;
}

describe("fork-module staging slab vs the built programs", () => {
  it("holds the largest admission any built artifact stages", () => {
    const artifacts = builtArtifacts();
    if (artifacts.length === 0) {
      process.stderr.write(
        "fork-module-staging-capacity: no programs are built, so the staging " +
          "slab was NOT measured against them. Build them to exercise this test.\n",
      );
      return;
    }
    // The live slab, from a real placement rather than a parsed constant.
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const fm = instantiateForkModule({
      module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
      memory,
      reserve: () => 8 * 1024 * 1024,
      label: "staging capacity",
    });

    let largest = { bytes: 0, what: "" };
    let instrumented = 0;
    for (const { name, bytes } of artifacts) {
      const size = admissionBytes(bytes);
      if (size === null) continue;
      instrumented += 1;
      if (size > largest.bytes) largest = { bytes: size, what: name };
    }
    // A run that measured NOTHING is not a pass. php alone is fork-instrumented
    // in every built tier, so zero instrumented artifacts means the measurement
    // itself broke.
    expect(instrumented, "fork-instrumented artifacts measured").toBeGreaterThan(0);
    expect(
      largest.bytes,
      `the largest admission is ${largest.what} at ${largest.bytes} bytes, against ` +
        `a ${fm.stagingBytes}-byte slab (${((fm.stagingBytes / largest.bytes) || 0).toFixed(2)}x). ` +
        `Raise STAGING_SLAB_BYTES in host/src/fork-module-instance.ts, in whole wasm pages, ` +
        `and record the new measurement in its comment.`,
    ).toBeLessThanOrEqual(fm.stagingBytes);
  });
});
