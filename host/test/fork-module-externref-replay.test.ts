// Phase 6 D6.2 — externref reference reconstruction ORCHESTRATED by the
// co-resident fork module and ROOTED through the REAL `wpk_fork_host` engine
// floor, proven end to end in a real WebAssembly engine (Node/V8).
//
// This is the externref analogue of `fork-module-funcref-replay.test.ts`. The
// crucial difference from funcref: an externref has NO linear-memory
// representation and there is no imported externref table to `table.get`, so
// `__wpk_fork_ref_decode_externref` STAYS a JS import (it returns the value).
// The module's job is to ORCHESTRATE the order and ROOT host-side identity
// through the `wpk_fork_host` seam. Here we build a REAL, externref-only KFMS
// reference transaction with the production host encoder, instantiate the module
// with the REAL seam bodies (`createForkModuleHostCapabilities`, backed by a
// broker token cache), drive `fm_begin_reference_replay`, and assert:
//
//   (a) PARITY — the token the module's `host_resolve_externref` roots for a
//       broker handle is `Object.is`-identical to `tokenCache.materialize(handle)`
//       (the same canonical token the still-JS decode import returns), so module
//       and JS agree on identity.
//   (b) PROOF OF USE — `fm_externrefs_resolved` advanced by the externref node
//       count AND the host bodies recorded that `resolve_externref` was invoked,
//       so the module (not a silent JS fallback) drove the reconstruction.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";
import { ForkExternrefTokenCache } from "../src/fork-reference-broker";
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
const PID = 4242;
const GENERATION_ID = 7;
// The durable broker handles this fork's externrefs name.
const HANDLES = [11, 22, 33] as const;

/** Build a sealed, externref-only KFMS arena in `memory`; return its root. */
function buildExternrefArena(memory: WebAssembly.Memory): number {
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
    "externref-replay-test",
  );

  // Node 0 is the mandatory canonical null; nodes 1..N are durable externrefs
  // naming broker handles. No aggregate consumer, so nothing is transit-rooted
  // (the plain externref-in-a-local D6.2 case).
  const nodes: ForkReferenceRecipeEntry[] = [
    { id: 0, node: { kind: "null" } },
    ...HANDLES.map((handle, index) => ({
      id: index + 1,
      node: { kind: "externref" as const, handle },
    })),
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

describe("fork-module externref reference reconstruction (Phase 6 D6.2)", () => {
  it("orchestrates externref re-rooting through the module with identity parity and proof of use", () => {
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });

    // The child worker's externref token cache — the SAME cache the still-JS
    // `__wpk_fork_ref_decode_externref` path would use, so the token the module
    // roots is byte-for-byte the canonical identity JS returns.
    const tokens = new ForkExternrefTokenCache(GENERATION_ID);
    const hostCapabilities = createForkModuleHostCapabilities({
      tokens,
      generationId: GENERATION_ID,
    });

    const root = buildExternrefArena(memory);

    const module = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
    const reserveBase = 8 * 1024 * 1024;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: PTR_WIDTH,
      reserve: () => reserveBase,
      label: "externref-replay-test",
      hostCapabilities: hostCapabilities.imports,
    });
    const x = fm.exports as unknown as {
      fm_set_format: (pw: number, fixedPrefix: number) => void;
      fm_begin_reference_replay: (root: number, pid: number) => void;
      fm_externrefs_resolved: () => bigint;
      fm_last_errno: () => number;
    };

    x.fm_set_format(PTR_WIDTH, 0);
    expect(x.fm_last_errno()).toBe(0);

    const before = Number(x.fm_externrefs_resolved());

    // Drive the reference reconstruction: the module walks the graph and calls
    // `host_resolve_externref` once per externref node (PHASE A), re-rooting
    // identity through the seam. No node is transit-reachable, so PHASE B
    // publishes nothing.
    x.fm_begin_reference_replay(root, PID);
    expect(x.fm_last_errno()).toBe(0);

    // (b) PROOF OF USE — the module counter advanced by the externref node
    // count, and the host bodies recorded that many resolve_externref calls.
    const after = Number(x.fm_externrefs_resolved());
    expect(after - before).toBe(HANDLES.length);
    expect(hostCapabilities.resolvedCount).toBe(HANDLES.length);

    // (a) PARITY — the module resolves externrefs in node (id) order, so the
    // i-th rooted ordinal (1-based) is HANDLES[i-1]. The token it rooted is the
    // SAME object `tokenCache.materialize(handle)` returns (idempotent cache).
    HANDLES.forEach((handle, index) => {
      const ordinal = index + 1;
      expect(hostCapabilities.rootedToken(ordinal)).toBe(tokens.materialize(handle));
    });

    // The rooted tokens are the canonical, worker-generation-tagged identities.
    expect(hostCapabilities.rootedToken(1)).not.toBe(hostCapabilities.rootedToken(2));
  });
});
