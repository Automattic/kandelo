// The staging slab must hold the largest single seed the programs this repo
// builds actually make.
//
// `STAGING_SLAB_BYTES` (`host/src/fork-module-instance.ts`) is sized from a
// measurement of the shipped artifacts, and a measurement written into a
// comment is a snapshot: the next php build with a bigger `intl.so` would make
// it wrong, and the failure would be "staging slab exhausted" at a `dlopen`
// inside a forking program, an hour and a package build away from the cause.
// This test re-measures the built artifacts against the live slab, in the
// same shape as `fork-identity-capacity.test.ts`, so the number fails HERE.
//
// WHAT IS MEASURED: every byte string `ForkModuleContinuationBackend` stages,
// per activation -- the resume catalog's ordinals (four bytes each), the GC
// codec, imported-globals (KFIG) and imported-tables (KFIT) sections, the
// exception codec, and the 32-byte template id. The slab is a per-call
// scratch, so the bound is the LARGEST of these across every artifact, not
// their sum; the per-process sum is reported as scale, because it is the
// number the previous, cursor-shaped slab would have needed.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  WPK_FORK_EXCEPTION_CODEC_SECTION,
  WPK_FORK_GC_CODEC_SECTION,
  WPK_FORK_IMPORTED_GLOBALS_SECTION,
  WPK_FORK_IMPORTED_TABLES_SECTION,
} from "../src/generated/abi";
import { readForkResumeCatalog } from "../src/fork-resume-catalog";

const TEMPLATE_ID_BYTES = 32;

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

/** The bytes each of one artifact's seeds stages, by name, or null if it is not fork-instrumented. */
function stagedSeeds(bytes: Uint8Array): Record<string, number> | null {
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (error) {
    if (error instanceof RangeError || error instanceof WebAssembly.CompileError) return null;
    throw error;
  }
  let ordinals: number;
  try {
    ordinals = readForkResumeCatalog(module).length;
  } catch (error) {
    // ONLY "this module has no catalog section" means "stages nothing"; see
    // `fork-identity-capacity.test.ts` for why anything else is re-thrown.
    if (!(error instanceof Error) || !/section/i.test(error.message)) throw error;
    return null;
  }
  const section = (name: string): number =>
    WebAssembly.Module.customSections(module, name)[0]?.byteLength ?? 0;
  return {
    "template id": TEMPLATE_ID_BYTES,
    "resume catalog": ordinals * 4,
    "GC codec": section(WPK_FORK_GC_CODEC_SECTION),
    "imported globals": section(WPK_FORK_IMPORTED_GLOBALS_SECTION),
    "imported tables": section(WPK_FORK_IMPORTED_TABLES_SECTION),
    "exception codec": section(WPK_FORK_EXCEPTION_CODEC_SECTION),
  };
}

describe("fork-module staging slab vs the built programs", () => {
  it("holds the largest single seed any built artifact stages", () => {
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
      ptrWidth: 4,
      reserve: () => 8 * 1024 * 1024,
      label: "staging capacity",
    });

    let largest = { bytes: 0, what: "" };
    let instrumented = 0;
    for (const { name, bytes } of artifacts) {
      const seeds = stagedSeeds(bytes);
      if (seeds === null) continue;
      instrumented += 1;
      for (const [what, size] of Object.entries(seeds)) {
        if (size > largest.bytes) largest = { bytes: size, what: `${name} ${what}` };
      }
    }
    // A run that measured NOTHING is not a pass. php alone is fork-instrumented
    // in every built tier, so zero instrumented artifacts means the measurement
    // itself broke.
    expect(instrumented, "fork-instrumented artifacts measured").toBeGreaterThan(0);
    expect(
      largest.bytes,
      `the largest single seed is ${largest.what} at ${largest.bytes} bytes, against ` +
        `a ${fm.stagingBytes}-byte slab (${((fm.stagingBytes / largest.bytes) || 0).toFixed(2)}x). ` +
        `Raise STAGING_SLAB_BYTES in host/src/fork-module-instance.ts, in whole wasm pages, ` +
        `and record the new measurement in its comment.`,
    ).toBeLessThanOrEqual(fm.stagingBytes);
  });
});
