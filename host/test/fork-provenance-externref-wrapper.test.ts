import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { buildForkGuestImports } from "../src/fork-guest-imports";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * The externref provenance wrapper, driven through REAL instrumented code.
 *
 * `__wpk_fork_ref_provenance_externref` is served by an injected identity shim
 * (census 191). Identity is its whole contract, and it is easy to miss how
 * load-bearing that is: `crates/fork-instrument/src/externref_provenance.rs`
 * emits `local.get result; call provenance; local.set result`, so whatever the
 * hook returns REPLACES the value the real host import produced, before the
 * guest's own code ever sees it. A shim returning null would substitute null
 * into the guest's data flow at every externref production site.
 *
 * Perturbing the shim to return null passed the entire fork suite. Census 191
 * recorded why and recorded the gap as owed: the pass rewrites DIRECT calls to
 * externref-returning imports only, and nothing in the tree has one. The
 * gated-externref fixture mints through `call_indirect` -- the residual gap
 * that pass records in its own header -- and the GC fixtures internalize a
 * guest-allocated `anyref` with no host call to wrap.
 *
 * So this file builds a guest that HAS one, through the production transform
 * (`run-wasm-fork-instrument.sh`, the same tool every fork-using package build
 * runs) rather than hand-writing the instrumented output -- a hand-written
 * wrapper would be this file's opinion of what the pass emits, which is
 * exactly the thing under test.
 *
 * What it asserts is the whole path at once: the pass wrapped the call, the
 * wrapper routed the result through the module's export, and the value that
 * reaches the guest's caller is the one the host import minted. No fork is
 * needed for that, and none would add to it -- the provenance the recording
 * used to feed no longer exists, so a fork exercises capture asking the host
 * for a handle instead (`__wpk_fork_host_externref_handle`), which is a
 * different seam with its own tests.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const instrument = join(repoRoot, "scripts", "run-wasm-fork-instrument.sh");
const PAGE = 65536;
const MODULE_BASE = 8 * 1024 * 1024;

let workspace: string | null = null;
afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** A guest that calls an externref-returning host import DIRECTLY. */
function instrumentedGuest(): WebAssembly.Module | null {
  if (!existsSync(instrument)) return null;
  workspace ??= mkdtempSync(join(tmpdir(), "kandelo-provenance-"));
  const out = join(workspace, "guest.wasm");
  if (!existsSync(out)) {
    const abi = /^pub const ABI_VERSION: u32 = (\d+);$/m.exec(
      readFileSync(join(repoRoot, "crates", "shared", "src", "lib.rs"), "utf8"),
    )?.[1];
    if (abi === undefined) return null;
    const wat = join(workspace, "guest.wat");
    const wasm = join(workspace, "guest.pre.wasm");
    writeFileSync(
      wat,
      `(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (import "env" "mint_externref" (func $mint (result externref)))
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const ${abi}))
  (func (export "mint_through_wrapper") (result externref)
    (call $mint))
  (func (export "_start")
    (drop (call $kernel_fork (i32.const 0)))))
`,
    );
    try {
      execFileSync("wat2wasm", [wat, "-o", wasm], { stdio: "pipe" });
      execFileSync("bash", [instrument, "--output", out, wasm], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch {
      return null;
    }
  }
  return new WebAssembly.Module(readFileSync(out));
}

describe("the externref provenance wrapper passes the value through", () => {
  const guest = instrumentedGuest();
  if (!guest) {
    // Provisioning, not a defect: needs `wat2wasm` and the instrument script.
    it.skip("fork instrumentation tooling is not available", () => {});
    return;
  }

  it("wraps the direct call at all, which is the premise of the rest", () => {
    // If the pass stopped rewriting this call the identity assertion below
    // would pass vacuously -- the guest would call its import directly and the
    // shim would never run. Asserting the import EXISTS is what keeps the next
    // test honest.
    const imports = WebAssembly.Module.imports(guest);
    expect(
      imports.some((i) => i.name === "__wpk_fork_ref_provenance_externref"),
      "the instrumented guest must declare the provenance import",
    ).toBe(true);
  });

  it("returns the value the host import minted, unchanged", () => {
    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 16384,
      shared: true,
    });
    const fm = instantiateForkModule({
      module: new WebAssembly.Module(
        readFileSync(resolveBinary("fork_module32.wasm")),
      ),
      memory,
      ptrWidth: 4,
      reserve: () => MODULE_BASE,
      label: "provenance wrapper",
    });

    // Everything the guest needs, from the module where the module serves it
    // and a stub everywhere else. The provenance export is NOT stubbed: it is
    // the subject, and it comes from the real artifact.
    const moduleExports: Record<string, unknown> = {};
    for (const imported of WebAssembly.Module.imports(guest)) {
      if (imported.module !== "env" || imported.kind !== "function") continue;
      if (imported.name === "mint_externref") continue;
      const real = (fm.exports as Record<string, unknown>)[imported.name];
      moduleExports[imported.name] = typeof real === "function" ? real : () => 0;
    }
    expect(
      moduleExports.__wpk_fork_ref_provenance_externref,
      "the shim under test must come from the real module",
    ).toBe((fm.exports as Record<string, unknown>).__wpk_fork_ref_provenance_externref);

    const env = buildForkGuestImports({
      moduleExports: { ...(fm.exports as Record<string, unknown>), ...moduleExports },
      extras: {
        __wpk_fork_resume_table: new WebAssembly.Table({
          element: "anyfunc",
          initial: 1,
        }),
        __wpk_fork_module_activation: new WebAssembly.Global(
          { value: "i32", mutable: false },
          0,
        ),
        // i64, not i32: the instrumenter emits this one as a 64-bit immutable
        // global regardless of the guest's pointer width, and the LinkError it
        // otherwise raises says only "imported global does not match the
        // expected type" -- naming no type and no fix.
        __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global(
          { value: "i64", mutable: false },
          0n,
        ),
      },
      guestModule: guest,
      label: "provenance wrapper guest",
    });

    // A FRESH object per call, so a shim that cached or substituted any single
    // value could not pass by coincidence.
    const minted: object[] = [];
    const instance = new WebAssembly.Instance(guest, {
      env: {
        ...(env as Record<string, WebAssembly.ImportValue>),
        mint_externref: () => {
          const value = Object.freeze({ nth: minted.length });
          minted.push(value);
          return value;
        },
      },
      kernel: { kernel_fork: () => 0 },
    });

    const call = instance.exports.mint_through_wrapper as () => unknown;
    for (let nth = 0; nth < 4; nth += 1) {
      const returned = call();
      expect(minted.length, "the host import ran").toBe(nth + 1);
      expect(returned, "and its value came back unchanged").toBe(minted[nth]);
    }
  });
});
