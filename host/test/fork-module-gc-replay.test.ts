// Phase 6 D6.4a — typed-GC (struct/array/i31) reference reconstruction ADMITTED
// by the co-resident fork module, with the module doing leaf-identity + transit
// rooting while the PROVEN JS drive-order keeps the allocate/fill topological
// walk plus cycle-breaking. Proven end to end in a real WebAssembly engine
// (Node/V8).
//
// This is the typed-GC analogue of `fork-module-exnref-replay.test.ts`. The
// crucial shape this exercises is a struct↔array CYCLE whose subgraph reaches an
// ALIASED externref leaf (id 0 is the canonical null every capture requires):
//
//   id 0 = null                                        (canonical)
//   id 1 = struct  -> array(2) + externref(3)          (fields [2, 3])
//   id 2 = array   -> struct(1) (back-edge) + externref(3) (alias)  (elements [1, 3])
//   id 3 = externref naming `LEAF_HANDLE`              (reached from BOTH)
//
// The module ADMITS this graph (typed GC), but the Struct/Array drive arms stay
// INERT: the fork side module is instantiated BEFORE the guest exists, so it
// cannot import the guest's `_gc_allocate`/`_gc_fill` exports; the guest still
// drives the GC allocate/fill under the JS order. The module's only GC job is
// rooting the reachable externref LEAF: PHASE B publishes it into the anyref
// transit at `recipe_id + 1` and reads it back with an identity check (the R1
// rooting guard). Despite the ALIAS (the leaf is reached from both the struct
// field and the array element), it must be rooted EXACTLY ONCE (dedup).
//
// Assertions:
//   (a) TRANSIT IDENTITY (silent-corruption-critical) — the token the module
//       publishes into the real anyref transit reads back `Object.is`-identical to
//       `tokens.materialize(handle)` (the canonical token the still-JS decode
//       import returns), rooted ONCE.
//   (b) PROOF OF USE — `fm_gc_nodes_reconstructed` advanced by the struct+array
//       count and `fm_externrefs_resolved` by the reachable-externref count.
//   (c) MINT INERT — `host_mint_exception_tag` was not called (no exnref).
//   (d) TRANSIT IS LOAD-BEARING — without a real transit the typed-GC drive fails
//       LOUD (EINVAL), never silently reconstructs a wrong/unrooted leaf.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  createForkModuleHostCapabilities,
  type ForkModuleTransitAdapter,
} from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
import { ForkAnyrefTransitTable } from "../src/fork-anyref-transit";
import { ForkModuleStateArena } from "../src/fork-module-state";
import type { ForkReferenceRecipeEntry } from "../src/fork-reference-recipes";
import {
  appendSegmentedForkReferenceTransaction,
  PagedForkReferenceVector,
  type ForkReferenceVector,
} from "../src/fork-reference-segments";
import { WPK_FORK_REFERENCE_TRANSACTION_OWNER } from "../src/generated/abi";

const PAGE = 65536;
const PTR_WIDTH = 4 as const;
const PID = 6262;
const GENERATION_ID = 11;
// The durable broker handle the aliased externref leaf names.
const LEAF_HANDLE = 77;

/**
 * Build a sealed KFMS arena holding the struct↔array cycle over an aliased
 * externref leaf described in the file header. The struct and array carry a few
 * scalar bytes each to exercise the aggregate blob path; the externref leaf is
 * reached from BOTH aggregate edges so the drive must dedup it.
 */
function buildGcCycleArena(memory: WebAssembly.Memory): number {
  let next = PAGE;
  const allocate = (size: number): number => {
    const addr = next;
    next += size;
    if (next > memory.buffer.byteLength) {
      memory.grow(Math.ceil((next - memory.buffer.byteLength) / PAGE));
    }
    return addr;
  };
  const arena = new ForkModuleStateArena(
    memory,
    PTR_WIDTH,
    allocate,
    () => {},
    "gc-replay-test",
  );

  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    {
      id: 1,
      node: {
        kind: "struct",
        moduleActivation: 0,
        typeOrdinal: 1,
        layoutId: 1,
        scalars: new Uint8Array([0x78, 0x56, 0x34, 0x12]),
        fields: [2, 3],
      },
    },
    {
      id: 2,
      node: {
        kind: "array",
        moduleActivation: 0,
        typeOrdinal: 2,
        layoutId: 2,
        scalars: new Uint8Array([0xaa, 0xbb]),
        elements: [1, 3],
      },
    },
    { id: 3, node: { kind: "externref", handle: LEAF_HANDLE } },
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xa0) });
  appendSegmentedForkReferenceTransaction(
    arena,
    WPK_FORK_REFERENCE_TRANSACTION_OWNER,
    nodes,
    vectors,
    // Force multi-segment reassembly so the module's decode is exercised.
    { segmentDataBytes: 48 },
  );
  arena.seal();
  return root;
}

interface ForkModuleRefExports {
  fm_set_format: (pw: number, fixedPrefix: number) => void;
  fm_begin_reference_replay: (root: number, pid: number) => void;
  fm_externrefs_resolved: () => bigint;
  fm_exnrefs_reconstructed: () => bigint;
  fm_gc_nodes_reconstructed: () => bigint;
  fm_last_errno: () => number;
}

/** A REAL transit adapter over the production `(ref null any)` table. Mirrors
 *  what `activationRegistry.publishEarlyGcTransit` / `readEarlyGcTransit` do:
 *  `set(recipeId + 1)` / `get(recipeId + 1)` on the anyref transit. */
function realTransit(table: ForkAnyrefTransitTable): ForkModuleTransitAdapter {
  return {
    publish: (recipeId, value) => {
      table.ensureRecipeSlot(recipeId);
      table.set(recipeId + 1, value);
    },
    read: (recipeId) => table.get(recipeId + 1),
  };
}

const MODULE = new WebAssembly.Module(
  readFileSync(resolveBinary("fork_module32.wasm")),
);

function instantiate(
  memory: WebAssembly.Memory,
  hostCapabilities: Readonly<Record<string, (...args: number[]) => number>>,
): ForkModuleRefExports {
  const reserveBase = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module: MODULE,
    memory,
    ptrWidth: PTR_WIDTH,
    reserve: () => reserveBase,
    label: "gc-replay-test",
    hostCapabilities,
  });
  return fm.exports as unknown as ForkModuleRefExports;
}

describe("fork-module typed-GC (struct/array/i31) admission + leaf rooting through the module (Phase 6 D6.4a)", () => {
  it("roots the aliased externref leaf of a struct↔array cycle in the real anyref transit ONCE with identity parity, advances the counters, and never mints a tag", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const transitTable = new ForkAnyrefTransitTable();
    const hostCapabilities = createForkModuleHostCapabilities({
      tokens,
      generationId: GENERATION_ID,
      transit: realTransit(transitTable),
    });

    // Spy on `host_mint_exception_tag` (inert stub for this seam) to prove the
    // typed-GC drive never mints an exception tag: there is no exnref, and the
    // module does not throw.
    let mintCalls = 0;
    const imports = {
      ...hostCapabilities.imports,
      host_mint_exception_tag: () => {
        mintCalls += 1;
        return 0;
      },
    };

    const root = buildGcCycleArena(memory);
    const x = instantiate(memory, imports);

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const externrefsBefore = Number(x.fm_externrefs_resolved());
    const gcNodesBefore = Number(x.fm_gc_nodes_reconstructed());
    const exnrefsBefore = Number(x.fm_exnrefs_reconstructed());

    // Drive the reconstruction: PHASE A resolves the aliased externref leaf ONCE
    // (the Struct/Array arms are inert); PHASE B publishes it into the REAL anyref
    // transit at recipe_id+1 and reads it back with an identity assert
    // (fm_last_errno stays 0 only if identity survived, the R1 guard).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE — two typed-GC nodes admitted (struct + array), one
    // externref leaf re-rooted, and NO exnref.
    expect(Number(x.fm_gc_nodes_reconstructed()) - gcNodesBefore).toBe(2);
    expect(Number(x.fm_externrefs_resolved()) - externrefsBefore).toBe(1);
    expect(Number(x.fm_exnrefs_reconstructed()) - exnrefsBefore).toBe(0);

    // (a) TRANSIT IDENTITY — the token the module rooted for the leaf is the SAME
    // object `tokens.materialize(handle)` returns (idempotent cache), and it is
    // what actually sits in the real anyref transit slot (recipe_id 3 -> slot 4),
    // rooted EXACTLY ONCE despite the alias. This is the silent-corruption-critical
    // assertion: the module rooted the same identity JS would, in a real
    // `(ref null any)` table.
    const canonical = tokens.materialize(LEAF_HANDLE);
    expect(hostCapabilities.rootedToken(1)).toBe(canonical);
    expect(transitTable.get(4)).toBe(canonical);
    // Dedup: exactly one externref was re-rooted through the seam despite two
    // aggregate edges naming it.
    expect(hostCapabilities.resolvedCount).toBe(1);

    // (c) MINT INERT — the typed-GC drive never minted an exception tag.
    expect(mintCalls).toBe(0);
  });

  it("fails LOUD when no real transit backs the cycle's reachable externref leaf (transit is load-bearing)", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    // No transit adapter: PHASE B has a reachable leaf to root, so the module
    // drives `host_transit_publish`, which fails EINVAL — never a silent unrooted
    // leaf feeding a corrupted GC graph.
    const hostCapabilities = createForkModuleHostCapabilities({
      tokens,
      generationId: GENERATION_ID,
    });

    const root = buildGcCycleArena(memory);
    const x = instantiate(memory, hostCapabilities.imports);

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).not.toBe(0);
  });
});
