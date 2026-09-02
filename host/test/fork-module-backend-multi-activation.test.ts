// Phase 6 D7a.1a-host: the N-arena backend must drive a dlopen fork's main
// activation (0) plus its side activations (1..N) through the co-resident
// module — each with its OWN host frame arena and per-activation resume catalog
// — and a fresh child must seed every activation's replay from copied memory.
// This exercises the backend's arena/catalog bookkeeping against the STAGED
// `fork_module32.wasm`, with the guest frame calls simulated by trampolines.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import {
  FORK_MODULE_FRAME_ARENA_BYTES,
  ForkModuleContinuationBackend,
} from "../src/fork-module-backend";
import { ForkModuleTrampolines } from "../src/fork-module-trampoline";
import type { LinkedFrameFormatDescriptor } from "../src/fork-continuation";

const PAGE = 65536;
const MiB = 1024 * 1024;

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

/** A page-aligned monotonic bump allocator over a slice of the shared memory. */
function bumpAllocator(start: number): { reserve: (n: number) => number } {
  let next = Math.ceil(start / PAGE) * PAGE;
  return {
    reserve: (n: number): number => {
      const base = next;
      next += Math.ceil(n / PAGE) * PAGE;
      return base;
    },
  };
}

const format = (fixedPrefixSize: number): LinkedFrameFormatDescriptor =>
  ({
    ptrWidth: 4,
    fixedPrefixSize,
    // chunkHeaderSize is used by beginChildReplay to derive the arena base from
    // the inherited root; the module returns roots at arena base + this header.
    chunkHeaderSize: 32,
    alignment: 16,
  }) as unknown as LinkedFrameFormatDescriptor;

interface Commit {
  act: number;
  func: number;
  fill: number;
  size: number;
}

const COMMITS: Commit[] = [
  { act: 0, func: 101, fill: 0xa1, size: 40 },
  { act: 1, func: 301, fill: 0xc1, size: 48 },
  { act: 0, func: 202, fill: 0xb2, size: 40 },
  { act: 1, func: 302, fill: 0xc2, size: 56 },
];
const CATALOG0 = [101, 202, 303];
const CATALOG1 = [301, 302, 399];
const PREFIX1 = 256;

function driveUnwind(
  trampolines: ForkModuleTrampolines,
  memory: WebAssembly.Memory,
  errno: () => number,
): void {
  for (const c of COMMITS) {
    const t = trampolines.instanceFor(c.act).exports as unknown as Record<
      string,
      (...a: number[]) => number
    >;
    const payload = t.__wpk_fork_frame_reserve(c.size) >>> 0;
    expect(errno()).toBe(0);
    const dv = new DataView(memory.buffer);
    dv.setUint32(payload + 0, c.func, true);
    dv.setUint32(payload + 4, 1, true);
    dv.setUint32(payload + 8, 0, true);
    dv.setUint32(payload + 12, 0, true);
    const buf = new Uint8Array(memory.buffer);
    for (let i = 16; i < c.size; i++) buf[payload + i] = c.fill;
    t.__wpk_fork_frame_commit(payload);
    expect(errno()).toBe(0);
  }
}

function driveReplay(
  trampolines: ForkModuleTrampolines,
  memory: WebAssembly.Memory,
  errno: () => number,
): void {
  for (const c of [...COMMITS].reverse()) {
    const t = trampolines.instanceFor(c.act).exports as unknown as Record<
      string,
      (...a: number[]) => number
    >;
    const peeked = t.__wpk_fork_frame_peek(c.size) >>> 0;
    expect(errno()).toBe(0);
    expect(new DataView(memory.buffer).getUint32(peeked, true)).toBe(c.func);
    const advanced = t.__wpk_fork_frame_next(c.size) >>> 0;
    expect(errno()).toBe(0);
    expect(new Uint8Array(memory.buffer)[advanced + 16]).toBe(c.fill);
  }
}

describe("ForkModuleContinuationBackend multi-activation", () => {
  it("drives a two-activation parent unwind + fresh child replay through the module", () => {
    // --- Parent -----------------------------------------------------------
    const parentMemory = new WebAssembly.Memory({
      initial: Math.ceil((48 * MiB) / PAGE),
      maximum: 16384,
      shared: true,
    });
    const alloc = bumpAllocator(4 * MiB);
    const fm = instantiateForkModule({
      module: loadForkModule32(),
      memory: parentMemory,
      ptrWidth: 4,
      reserve: alloc.reserve,
      label: "backend-parent",
    });
    const px = fm.exports as ForkModuleExports;
    const perr = (): number => Number((px.fm_last_errno as () => number)());

    const backend = new ForkModuleContinuationBackend({
      exports: px,
      memory: parentMemory,
      ptrWidth: 4,
      format: format(128),
      catalogOrdinals: CATALOG0,
      reserveRegion: alloc.reserve,
      releaseRegion: () => {},
      frameArenaBytes: FORK_MODULE_FRAME_ARENA_BYTES,
      pid: 1,
      label: "backend-parent",
    });
    backend.setup();
    backend.setActivationResumeCatalog(1, CATALOG1);
    const root0 = backend.beginUnwind();
    expect(root0).toBeGreaterThan(0);
    const root1 = backend.addActivationUnwind(1, PREFIX1);
    expect(root1).toBeGreaterThan(0);
    expect(root1).not.toBe(root0);

    const parentTrampolines = new ForkModuleTrampolines(px);
    driveUnwind(parentTrampolines, parentMemory, perr);
    backend.finishUnwindAndSerialize();
    expect(Number(backend.framesCommitted())).toBe(COMMITS.length);

    backend.beginParentReplay();
    driveReplay(parentTrampolines, parentMemory, perr);
    backend.finishReplay();

    // --- Child: fresh instance at a different placement, empty journal ------
    const childMemory = new WebAssembly.Memory({
      initial: parentMemory.buffer.byteLength / PAGE,
      maximum: 16384,
      shared: true,
    });
    // Simulate the fork address-space copy.
    new Uint8Array(childMemory.buffer).set(new Uint8Array(parentMemory.buffer));
    const childAlloc = bumpAllocator(2 * MiB); // different module placement
    const childFm = instantiateForkModule({
      module: loadForkModule32(),
      memory: childMemory,
      ptrWidth: 4,
      reserve: childAlloc.reserve,
      label: "backend-child",
    });
    const cx = childFm.exports as ForkModuleExports;
    const cerr = (): number => Number((cx.fm_last_errno as () => number)());
    const childBackend = new ForkModuleContinuationBackend({
      exports: cx,
      memory: childMemory,
      ptrWidth: 4,
      format: format(128),
      catalogOrdinals: CATALOG0,
      reserveRegion: childAlloc.reserve,
      releaseRegion: () => {},
      frameArenaBytes: FORK_MODULE_FRAME_ARENA_BYTES,
      pid: 2,
      label: "backend-child",
    });
    childBackend.setup();
    childBackend.setActivationResumeCatalog(1, CATALOG1);
    childBackend.beginChildReplay(root0);
    childBackend.addActivationChildReplay(1, root1, PREFIX1);

    const childTrampolines = new ForkModuleTrampolines(cx);
    driveReplay(childTrampolines, childMemory, cerr);
    childBackend.finishReplay();
    // A replay-only child never commits; the replayed counter is the proof.
    expect(Number(childBackend.framesReplayed())).toBeGreaterThanOrEqual(
      COMMITS.length,
    );
  });
});
