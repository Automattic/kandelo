import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  FORK_MODULE_REQUIRED_EXPORTS,
  instantiateForkModule,
} from "../src/fork-module-instance";

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
    // The reserved region covers the module's ~4 MiB static footprint plus the
    // shadow stack, and fits inside the provided memory.
    expect(reserved!.size).toBeGreaterThan(4 * 1024 * 1024);
    expect(fm.memoryBase + fm.regionBytes).toBeLessThanOrEqual(
      memory.buffer.byteLength,
    );

    for (const name of FORK_MODULE_REQUIRED_EXPORTS) {
      expect(typeof fm.exports[name]).toBe("function");
    }

    // The instance is live: a trivial exported query runs without trapping.
    expect(() => (fm.exports.fm_last_errno as () => number)()).not.toThrow();

    // Co-residency: instantiating (which ran the module's data-reloc start)
    // did not clobber the guest sentinel below the reserved region.
    expect(new DataView(memory.buffer).getUint32(sentinelAddr, true)).toBe(
      0xdeadbeef,
    );
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
