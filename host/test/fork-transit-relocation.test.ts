// M1: ONE anyref GC transit table per process, not three.
//
// The table the fork-module exports, the table the host wraps, and the table
// the guest imports must be the SAME `WebAssembly.Table` object. Three tables
// that each work in isolation lose every reference published across them, and
// the runtime drive check only catches it when a value happens to cross.
//
// THIS USED TO ASSERT IT THROUGH `ForkActivationRegistry`, which is gone: the
// registry minted a transit table and then ADOPTED the module's, and this file
// pinned that adoption. There is nothing to adopt now -- the module owns the
// table from the moment it is instantiated, and `buildForkGuestImports` binds
// the module's own non-function exports into the guest's `env`, so the sharing
// is structural rather than arranged. What that deleted the SECOND test of this
// file (adopting into an already-built registry) along with its subject; the
// first assertion is stronger than before, because it now runs against the
// production import path instead of a registry only tests constructed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { buildForkGuestImports } from "../src/fork-guest-imports";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT } from "../src/generated/abi";

function forkModule(): ReturnType<typeof instantiateForkModule> {
  return instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory: new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    }),
    ptrWidth: 4,
    reserve: () => 8 * 1024 * 1024,
    label: "transit relocation",
  });
}

describe("the GC transit table is relocated into the fork-module", () => {
  it("shares ONE table across the module export, the host wrapper, and the guest import", () => {
    const fm = forkModule();

    // The host's wrapper does not mint; it wraps what the module exported.
    const wrapper = new ForkAnyrefTransitTable(fm.exports);
    expect(wrapper.table).toBe(fm.gcTransitTable);

    // And the guest's import is that same object, bound by the builder that
    // production uses -- not by anything this test arranged.
    const imports = buildForkGuestImports({
      moduleExports: fm.exports as Record<string, unknown>,
      // The resume table is the host's (it holds the guest's own resume
      // targets), so the builder requires it and this supplies an empty one.
      // It is not the subject: the assertion below is about the table the
      // MODULE owns.
      extras: {
        __wpk_fork_resume_table: new WebAssembly.Table({
          element: "anyfunc",
          initial: 0,
        }),
      },
      label: "transit relocation imports",
    });
    expect(imports[WPK_FORK_REFERENCE_IMPORT_GC_TRANSIT]).toBe(fm.gcTransitTable);
  });

  it("gives each module instance its own table, so two processes cannot share one", () => {
    // The flip side of the assertion above, and the reason it is about
    // identity rather than shape: one table per PROCESS. Two instances sharing
    // a table would publish each other's references into the same slots, which
    // is a cross-process reference leak no drive check could see.
    const first = forkModule();
    const second = forkModule();
    expect(first.gcTransitTable).not.toBe(second.gcTransitTable);
  });
});
