import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  FORK_MODULE_REQUIRED_EXPORTS,
  instantiateForkModule,
} from "../src/fork-module-instance";
import { arenaFixture } from "./fork-module-capture-fixture";

const PAGE = 65536;

function loadForkModule32(): WebAssembly.Module {
  const buf = readFileSync(resolveBinary("fork_module32.wasm"));
  return new WebAssembly.Module(buf);
}

function sharedMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 16384, shared: true });
}

describe("instantiateForkModule", () => {
  it("places the PIC fork-module into a host-reserved region and exposes its continuation exports", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    // A live-guest sentinel at a low offset must survive co-residency: the
    // module's static/BSS/stack live in the host-reserved region only.
    const sentinelAddr = 4096;
    new DataView(memory.buffer).setUint32(sentinelAddr, 0xdeadbeef, true);

    // Bump allocator standing in for the channel mmap: a page-aligned base
    // well above the sentinel.
    const reserveBase = 8 * 1024 * 1024;
    let reserved: { base: number; size: number } | null = null;
    const reserve = (size: number): number => {
      reserved = { base: reserveBase, size };
      return reserveBase;
    };

    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });

    expect(fm.memoryBase).toBe(reserveBase);
    expect(reserved).not.toBeNull();
    // WHAT THIS ASSERTS, and why not a constant: the region must cover the
    // module's OWN declared static footprint plus its shadow stack and staging
    // slab. The previous `> 4 MiB` was a floor on memory USE -- it failed when
    // the module shrank, which is the goal of the storage work, and it did
    // fail during the spec experiment at 3,735,552 bytes.
    expect(reserved!.size).toBe(fm.regionBytes);
    expect(fm.regionBytes).toBeGreaterThanOrEqual(
      fm.staticBytes + fm.shadowStackBytes + fm.stagingBytes,
    );
    expect(fm.memoryBase + fm.regionBytes).toBeLessThanOrEqual(
      memory.buffer.byteLength,
    );

    for (const name of FORK_MODULE_REQUIRED_EXPORTS) {
      // `__wpk_fork_ref_gc_transit` (M1 task 2) is a module-owned
      // `WebAssembly.Table` export, not a function; every other required
      // export is a function.
      if (name === "__wpk_fork_ref_gc_transit") {
        expect(fm.exports[name]).toBeInstanceOf(WebAssembly.Table);
      } else {
        expect(typeof fm.exports[name]).toBe("function");
      }
    }

    // The instance is live: a trivial exported query runs without trapping.
    expect(() => (fm.exports.fm_last_errno as () => number)()).not.toThrow();

    // Co-residency: instantiating (which ran the module's data-reloc start)
    // did not clobber the guest sentinel below the reserved region.
    expect(new DataView(memory.buffer).getUint32(sentinelAddr, true)).toBe(
      0xdeadbeef,
    );
  });

  it("registers a resume catalog of any size: the old caps are gone", () => {
    // Phase 3 raised `RESUME_CATALOG_CAP` from 16,384 to 65,536 so the
    // co-resident module backed EVERY real fork -- php-fpm (19,190), php
    // (19,026) and node/spidermonkey (16,555) all exceeded the old cap. The
    // cap is gone now: activation 0's catalog is an arena record like every
    // other activation's, sized to the request, and the only boundary left is
    // the channel's own (`channel_mmap`'s errno), which the test below this
    // one reaches by giving the module no channel at all.
    //
    // WHY THIS RUNS ON `arenaFixture` AND NOT ON THE BARE INSTANCE ABOVE.
    // Seeding a catalog REGISTERS it, and registration now allocates the
    // activation's `(ordinal, slot)` record in the arena — which maps its
    // chunks with `channel_mmap`. A module whose `fm_set_format` was given no
    // channel base answers `EINVAL` from `channel_base()` instead, which is the
    // truthful answer for a module that genuinely cannot own storage. So the
    // fixture that carries a channel responder is the one that can drive this
    // path at all; the bare-instance rig above still covers everything that
    // does not allocate.
    //
    // That is a real behaviour change and it reached a real host:
    // `crates/host-native` passed 0 as `fm_set_format`'s channel-base argument,
    // so it could not have registered here either. It passes its channel offset
    // now, like the Node and browser hosts always have.
    const x = arenaFixture("resume catalog size");
    // THE RESPONDER NEVER REUSES AN ADDRESS and never grows the memory: it
    // bump-allocates upward from its floor in the fixture's 16 MiB. The three
    // seeds below map three assignment records (160 KiB, 512 KiB, 512 KiB,
    // each page-rounded) plus the arena's chunks -- and, since the bump heap
    // lost its static floor, its 1 MiB chunks come through the same window.
    // Without more room the publish's own bound (`end > mem_len_bytes()`)
    // answers a truthful ENOMEM for a rig limit, so the memory is grown here.
    // A property of the test rig, not of the module: a kernel reuses pages.
    x.memory.grow(128); // 8 MiB
    const OLD_CAP = 65_536;
    // A catalog exceeding the OLDEST cap registers cleanly.
    x.seedActivationCatalog(0, Array.from({ length: 20_000 }, (_, i) => i));
    expect(x.errno(), "20,000 ordinals: past the 16,384 cap").toBe(0);
    // Exactly at the later cap: accepted, and a re-seed of activation 0
    // replaces the first catalog. This is the largest assignment the arena is
    // asked for anywhere -- 65,536 records, 512 KiB in one chunk sized to the
    // request.
    x.seedActivationCatalog(0, Array.from({ length: OLD_CAP }, (_, i) => i));
    expect(x.errno(), "exactly at the old cap").toBe(0);
    // One past it: ACCEPTED. There is no cap to answer E2BIG for; a catalog
    // the arena can map is a catalog the module holds.
    x.seedActivationCatalog(0, Array.from({ length: OLD_CAP + 1 }, (_, i) => i));
    expect(x.errno(), "one past the old cap is not a boundary any more").toBe(0);
    expect(x.publishedSlots(0).length, "and every ordinal got a slot").toBe(OLD_CAP + 1);
  });

  it("refuses to register a resume catalog when it has no channel to store it in", () => {
    // THE OTHER HALF OF THE TEST ABOVE, and the reason it had to move. A module
    // with no syscall channel cannot map a chunk, so it cannot record an
    // activation's slot assignment -- and the honest answer is the errno, not a
    // registration that quietly stores nothing and hands the guest slot numbers
    // no one can free.
    //
    // `EINVAL` is `channel_base()`'s refusal for an unseeded `CHANNEL_BASE`,
    // reached through `arena_map_chunk`. Asserted here so that the day someone
    // gives the arena a channel-less fallback, this goes red rather than the
    // fallback going unnoticed.
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: () => 8 * 1024 * 1024,
      label: "test",
    });
    // Four arguments, not five: no channel base, which is what a caller that
    // has no channel passes.
    (fm.exports.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0);
    expect((fm.exports.fm_last_errno as () => number)()).toBe(0);

    const catalogAddr = 1 * 1024 * 1024; // 1 MiB, well below the module region
    const view = new DataView(memory.buffer);
    for (let i = 0; i < 4; i++) view.setUint32(catalogAddr + i * 4, i, true);
    (fm.exports.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void)(
      0,
      catalogAddr,
      4,
    );
    const EINVAL = 22;
    expect(
      (fm.exports.fm_last_errno as () => number)(),
      "a module with no channel cannot register slots, and says so",
    ).toBe(EINVAL);
  });

  it("exposes the module-owned GC transit table without minting a provider", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };

    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve,
      label: "test",
    });

    expect(fm.gcTransitTable).toBeInstanceOf(WebAssembly.Table);
  });

  it("ignores a supplied transitTable option as a harmless no-op (deprecated)", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(256); // 16 MiB
    const reserveBase = 8 * 1024 * 1024;
    const reserve = (size: number): number => {
      void size;
      return reserveBase;
    };
    const unusedProvidedTable = new WebAssembly.Table({
      element: "anyfunc",
      initial: 0,
    });

    expect(() =>
      instantiateForkModule({
        module,
        memory,
        ptrWidth: 4,
        reserve,
        label: "test",
        // Deprecated option; must not throw or otherwise change behavior.
        transitTable: unusedProvidedTable,
      }),
    ).not.toThrow();
  });

  it("fails loudly when the module is not a PIC side module", () => {
    // Minimal valid wasm module with no dylink.0 section.
    const trivial = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(() =>
      instantiateForkModule({
        module: trivial,
        memory: sharedMemory(4),
        ptrWidth: 4,
        reserve: () => 0,
        label: "test",
      })
    ).toThrow(/side module|dylink/i);
  });

  it("fails loudly when the reserved region exceeds the provided memory", () => {
    const module = loadForkModule32();
    const memory = sharedMemory(80); // ~5.24 MiB, too small for base + region
    expect(() =>
      instantiateForkModule({
        module,
        memory,
        ptrWidth: 4,
        reserve: () => 4 * 1024 * 1024,
        label: "test",
      })
    ).toThrow(/region|memory/i);
  });
});

// Silence unused-import lint if PAGE is not otherwise referenced.
void PAGE;
