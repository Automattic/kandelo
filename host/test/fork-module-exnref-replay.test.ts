// Phase 6 D6.3a — exnref reference reconstruction ORCHESTRATED by the co-resident
// fork module, with the anyref TRANSIT brought into PRODUCTION so the exnref's
// reachable externref payload is ROOTED in the REAL `(ref null any)` table before
// the guest codec materializes the exception. Proven end to end in a real
// WebAssembly engine (Node/V8).
//
// This is the exnref analogue of `fork-module-externref-replay.test.ts`. The
// crucial additions over the externref (D6.2) case:
//
//   * The graph has an EXNREF whose reference payload names an externref, so the
//     externref is TRANSIT-REACHABLE: the module's PHASE B publishes it into the
//     anyref transit at `recipe_id + 1` and reads it back with an identity check
//     (the R1 rooting guard). D6.2 left the transit adapter latent (`transit:
//     undefined`); here we wire a REAL adapter over `ForkAnyrefTransitTable` — the
//     SAME `(ref null any)` object `activationRegistry.publishEarlyGcTransit` /
//     `readEarlyGcTransit` wrap in production — so `host_transit_publish` /
//     `host_transit_read` actually root identity in a real anyref table.
//   * The module does NOT mint an exception tag or throw: the program exception
//     tag is guest-module-local, so the guest export
//     `__wpk_fork_exception_materialize` owns the throw/`catch_ref`. We assert
//     `host_mint_exception_tag` is NEVER called during the drive (it stays inert).
//
// Assertions:
//   (a) TRANSIT IDENTITY (silent-corruption-critical) — the token the module
//       publishes into the real anyref transit reads back `Object.is`-identical to
//       `tokens.materialize(handle)` (the canonical token the still-JS decode
//       import returns). fm_last_errno === 0 means the module's own read-back
//       identity assert passed; we ALSO read the transit slot directly to confirm.
//   (b) PROOF OF USE — `fm_exnrefs_reconstructed` advanced by the exnref-node
//       count and `fm_externrefs_resolved` by the payload count.
//   (c) MINT INERT — `host_mint_exception_tag` was not called.
//   (d) TRANSIT IS LOAD-BEARING — without a real transit the exnref drive fails
//       LOUD (EINVAL), never silently reconstructs a wrong/unrooted payload.

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
const PID = 5151;
const GENERATION_ID = 9;
// The durable broker handle the exnref's reference payload names.
const PAYLOAD_HANDLE = 44;

/**
 * Build a sealed KFMS arena holding an exnref-over-externref graph:
 *   id 0 = canonical null
 *   id 1 = externref naming `PAYLOAD_HANDLE`
 *   id 2 = exnref whose reference payload edge names id 1 (transit-reachable)
 */
function buildExnrefArena(memory: WebAssembly.Memory): number {
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
    "exnref-replay-test",
  );

  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    { id: 1, node: { kind: "externref", handle: PAYLOAD_HANDLE } },
    {
      id: 2,
      node: {
        kind: "exnref",
        moduleActivation: 0,
        tagOrdinal: 0,
        layoutId: 0,
        scalars: new Uint8Array(0),
        payloads: [1],
      },
    },
  ];
  const vectors: ForkReferenceVector[] = [PagedForkReferenceVector.empty];

  const root = arena.begin();
  arena.appendModule({ activationId: 0, templateId: new Uint8Array(32).fill(0xe0) });
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
    label: "exnref-replay-test",
    hostCapabilities,
  });
  return fm.exports as unknown as ForkModuleRefExports;
}

describe("fork-module exnref reference reconstruction + transit into production (Phase 6 D6.3a)", () => {
  it("roots the exnref's reachable externref payload in the real anyref transit with identity parity, advances the counters, and never mints a tag", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const transitTable = new ForkAnyrefTransitTable();
    const hostCapabilities = createForkModuleHostCapabilities({
      tokens,
      generationId: GENERATION_ID,
      transit: realTransit(transitTable),
    });

    // Spy on `host_mint_exception_tag` (inert stub in production for this seam)
    // to prove the drive never mints an exception tag: the guest export owns it.
    let mintCalls = 0;
    const imports = {
      ...hostCapabilities.imports,
      host_mint_exception_tag: () => {
        mintCalls += 1;
        return 0;
      },
    };

    const root = buildExnrefArena(memory);
    const x = instantiate(memory, imports);

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const externrefsBefore = Number(x.fm_externrefs_resolved());
    const exnrefsBefore = Number(x.fm_exnrefs_reconstructed());

    // Drive the reconstruction: PHASE A resolves the externref payload; PHASE B
    // publishes it into the REAL anyref transit at recipe_id+1 and reads it back
    // with an identity assert (fm_last_errno stays 0 only if identity survived).
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE — one exnref admitted, one externref payload re-rooted.
    expect(Number(x.fm_exnrefs_reconstructed()) - exnrefsBefore).toBe(1);
    expect(Number(x.fm_externrefs_resolved()) - externrefsBefore).toBe(1);

    // (a) TRANSIT IDENTITY — the token the module rooted for the payload is the
    // SAME object `tokens.materialize(handle)` returns (idempotent cache), and it
    // is what actually sits in the real anyref transit slot (recipe_id 1 -> slot
    // 2). This is the silent-corruption-critical assertion: the module rooted the
    // same identity JS would, in a real `(ref null any)` table.
    const canonical = tokens.materialize(PAYLOAD_HANDLE);
    expect(hostCapabilities.rootedToken(1)).toBe(canonical);
    expect(transitTable.get(2)).toBe(canonical);

    // (c) MINT INERT — the drive never minted an exception tag.
    expect(mintCalls).toBe(0);
    expect(hostCapabilities.resolvedCount).toBe(1);
  });

  it("fails LOUD when no real transit backs the exnref's transit-reachable payload (transit is load-bearing)", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    // No transit adapter: the D6.2 latent state. PHASE B has a reachable payload
    // to root, so the module drives `host_transit_publish`, which fails EINVAL.
    const hostCapabilities = createForkModuleHostCapabilities({
      tokens,
      generationId: GENERATION_ID,
    });

    const root = buildExnrefArena(memory);
    const x = instantiate(memory, hostCapabilities.imports);

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    // The exnref drive reaches PHASE B, calls host_transit_publish with no transit
    // backing, and fails truthfully — never a silent unrooted payload.
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).not.toBe(0);
  });
});
