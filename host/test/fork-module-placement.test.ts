import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { instantiateForkModule } from "../src/fork-module-instance";

/**
 * Placement guards, pinned by their OWN failure and not by any failure.
 *
 * `fork-module-instance.test.ts` already asserts that a non-PIC module and an
 * oversized region both throw. Both of those assertions survive the guard being
 * deleted, because something else throws with a message the regex still
 * matches: with the dylink check removed the parser falls through and reports
 * "dylink.0 carries no memory-info subsection" (still matches `/dylink/i`), and
 * with the bounds check removed `WebAssembly.Instance` itself fails with a
 * message containing "memory" (still matches `/region|memory/i`). A guard that
 * cannot fail is not a guard, so these assert the specific message each guard
 * produces.
 *
 * Loaded by explicit path rather than through the resolver, which prefers a
 * tier a local-build projection writes later (master-plan H-9).
 */
const wasmPath = join(
  __dirname,
  "..",
  "..",
  "local-binaries",
  "fork_module32.wasm",
);
const PAGE = 65536;

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: 16384,
    shared: true,
  });
}

describe("fork-module placement", () => {
  it("names the missing dylink.0 as NOT A SIDE MODULE, not as a parse failure", () => {
    const trivial = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(() =>
      instantiateForkModule({
        module: trivial,
        memory: sharedMemory(4),
        ptrWidth: 4,
        reserve: () => 0,
        label: "placement-test",
      }),
    ).toThrow(/not a PIC side module/);
  });

  if (!existsSync(wasmPath)) {
    // Provisioning, not a defect: build with
    // `crates/fork-module/build-wasm.sh`.
    it.skip("fork module not built", () => {});
    return;
  }
  const module = new WebAssembly.Module(readFileSync(wasmPath));

  it("reports an over-large region ITSELF, before WebAssembly does", () => {
    expect(() =>
      instantiateForkModule({
        module,
        memory: sharedMemory(80),
        ptrWidth: 4,
        reserve: () => 4 * 1024 * 1024,
        label: "placement-test",
      }),
    ).toThrow(/does not fit in the provided memory/);
  });

  it("puts the shadow stack at the TOP of the region, so it cannot grow into guest memory", () => {
    // The module's shadow stack grows DOWN. If `__stack_pointer` were seeded at
    // the region BASE instead of its top, the first call that spills would
    // write BELOW the region -- into live guest memory -- and nothing else in
    // this suite would notice, because the existing sentinel sits megabytes
    // further down. This sentinel sits immediately under the base, where a
    // downward-growing stack lands on its first spill.
    const memory = sharedMemory(512);
    const base = 16 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: () => base,
      label: "placement-test",
    });
    expect(fm.memoryBase).toBe(base);

    const guard = base - 8;
    const view = new DataView(memory.buffer);
    view.setUint32(guard, 0xfeedface, true);
    view.setUint32(guard + 4, 0xfeedface, true);

    // Any real call spills to the shadow stack.
    (fm.exports.fm_set_format as (w: number, p: number) => void)(4, 0);
    (fm.exports.fm_stats as (field: number) => bigint)(0);
    (fm.exports.fm_last_errno as () => number)();

    expect(view.getUint32(guard, true)).toBe(0xfeedface);
    expect(view.getUint32(guard + 4, true)).toBe(0xfeedface);
    // And the stack must live inside the region it was reserved for.
    expect(fm.memoryBase + fm.regionBytes).toBeLessThanOrEqual(
      memory.buffer.byteLength,
    );
  });

  it("puts the staging slab inside the region and ABOVE the shadow stack", () => {
    // The slab exists so staging never grows the shared process memory: a
    // fork-from-thread child clones that memory and must observe its parent's
    // exact size. If the stack could grow into the slab, staged bytes would be
    // corrupted by any deep call instead.
    const memory = sharedMemory(512);
    const base = 16 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: () => base,
      label: "placement-test",
    });

    expect(fm.stagingBytes).toBeGreaterThan(0);
    expect(fm.stagingBase).toBeGreaterThan(fm.memoryBase);
    expect(fm.stagingBase + fm.stagingBytes).toBeLessThanOrEqual(
      fm.memoryBase + fm.regionBytes,
    );

    const view = new DataView(memory.buffer);
    view.setUint32(fm.stagingBase, 0x5ab5ab00, true);
    view.setUint32(fm.stagingBase + fm.stagingBytes - 4, 0x5ab5ab01, true);

    (fm.exports.fm_set_format as (w: number, p: number) => void)(4, 0);
    (fm.exports.fm_stats as (field: number) => bigint)(0);
    (fm.exports.fm_last_errno as () => number)();

    expect(view.getUint32(fm.stagingBase, true)).toBe(0x5ab5ab00);
    expect(view.getUint32(fm.stagingBase + fm.stagingBytes - 4, true)).toBe(
      0x5ab5ab01,
    );
  });

  it("derives BOTH host functions from a token registry, never just the resolver", () => {
    // Wiring `resolve_externref` while leaving reference identity a trapping
    // stub is a mistake a caller should not be able to make. Both earlier
    // worker-main call sites made it.
    const value = { live: true };
    const fm = instantiateForkModule({
      module,
      memory: sharedMemory(512),
      ptrWidth: 4,
      reserve: () => 16 * 1024 * 1024,
      label: "placement-test",
      tokens: {
        materialize: (handle: number) => {
          if (handle !== 7) throw new RangeError(`no handle ${handle}`);
          return value;
        },
      },
    });
    expect(fm.capabilities).toBeDefined();
    expect(fm.capabilities!.imports.resolve_externref(7)).toBe(value);
    expect(fm.capabilities!.resolvedCount).toBe(1);
    const a = {};
    const id = fm.capabilities!.imports.__wpk_fork_host_ref_identity;
    expect(id(a)).toBe(id(a));
    expect(id(a)).not.toBe(id({}));
  });

  it("exposes the host-supplied tables so catalogs can be published into them", () => {
    const fm = instantiateForkModule({
      module,
      memory: sharedMemory(512),
      ptrWidth: 4,
      reserve: () => 16 * 1024 * 1024,
      label: "placement-test",
    });
    expect(fm.functionCatalog).toBeInstanceOf(WebAssembly.Table);
    expect(fm.driveTable).toBeInstanceOf(WebAssembly.Table);
    expect(fm.staticRootCatalog).toBeInstanceOf(WebAssembly.Table);
    // The transit table is the module's OWN export, not one of ours.
    expect(fm.gcTransitTable).toBeInstanceOf(WebAssembly.Table);
    expect(fm.gcTransitTable).not.toBe(fm.driveTable);
  });
});

void PAGE;
