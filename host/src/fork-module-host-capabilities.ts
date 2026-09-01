// Phase 6 D6.2 — the REAL engine-floor `wpk_fork_host.*` import bodies that back
// the co-resident fork-module's `WpkForkHost` seam.
//
// The co-resident module (crates/fork-module) ORCHESTRATES reference
// reconstruction but cannot hold a live `externref` — Wasm has no linear-memory
// representation for a reference. So during `fm_begin_reference_replay` the
// module drives this seam once per value with OPAQUE `u32` ordinals, and the
// host keeps the real identity in a side table:
//
//   * `host_begin_generation(pid)` opens the fork's host root scope (returns the
//     externref worker generation id, a non-zero ordinal),
//   * `host_resolve_externref(gen, handle)` re-roots the durable externref named
//     by `handle` — materializing the SAME canonical token the still-JS
//     `__wpk_fork_ref_decode_externref` import returns for that handle (identity
//     parity) — and hands the module an ordinal into a side table,
//   * `host_transit_publish` / `host_transit_read` stage a reconstructed ref in
//     the anyref transit at `recipe_id + 1` and read it back with an identity
//     check (the R1 rooting guard). Used only for externrefs reachable from a GC
//     struct/array or exnref consumer (D6.3/6.4); a plain externref-in-a-local
//     fork (D6.2) publishes nothing here.
//   * `host_release_generation(gen)` drops this fork's ordinal roots. It does NOT
//     clear the shared externref token cache: the JS reference path still owns
//     that and clears it at process/exec teardown.
//
// `__wpk_fork_ref_decode_externref` STAYS a JS import (it returns the value):
// the module re-roots identity FROM integers through this seam, then that JS
// import returns the value the module caused to be resolved. No live reference
// ever crosses into the module.

import type { ForkExternrefTokenCache } from "./fork-reference-broker";

/**
 * The anyref transit the transit-publish/read bodies bridge to. For a plain
 * externref fork (D6.2) it is never driven; the GC/exception slices (D6.3/6.4)
 * supply the real `any.convert_extern`-backed transit. `publish` stores a
 * reconstructed reference at `recipeId`; `read` returns it (or a different
 * identity if the engine lost the slot, which the module's R1 guard rejects).
 */
export interface ForkModuleTransitAdapter {
  publish(recipeId: number, value: unknown): void;
  read(recipeId: number): unknown;
}

export interface ForkModuleHostCapabilitiesBacking {
  /**
   * The child worker's externref token cache (broker handle -> canonical
   * worker-local token). `materialize` is idempotent, so the token the module
   * re-roots for a handle is the SAME object the JS decode path returns.
   */
  readonly tokens: ForkExternrefTokenCache;
  /**
   * The non-zero host generation ordinal `host_begin_generation` returns — the
   * externref worker generation that owns this fork's rooted identities.
   */
  readonly generationId: number;
  /**
   * The anyref transit (D6.3/6.4). Optional: a plain externref fork never
   * publishes into the transit, so D6.2 production passes none. When absent, the
   * transit bodies are a truthful `EINVAL` (they are never called for an
   * admitted D6.2 graph).
   */
  readonly transit?: ForkModuleTransitAdapter;
}

/** Errno codes the seam reports through the sticky `host_last_errno` cell. */
const EINVAL = 22;

export interface ForkModuleHostCapabilities {
  /** The `wpk_fork_host.*` import bodies to hand `instantiateForkModule`. */
  readonly imports: Readonly<Record<string, (...args: number[]) => number>>;
  /** The canonical token the seam rooted at `ordinal` (parity inspector). */
  rootedToken(ordinal: number): unknown;
  /** Number of externrefs re-rooted through the seam (proof-of-use inspector). */
  readonly resolvedCount: number;
}

/**
 * Build the real `wpk_fork_host.*` bodies backed by `backing`. Pass
 * `result.imports` as `instantiateForkModule({ hostCapabilities })`; the module
 * routes its `WpkForkHost` seam through them during `fm_begin_reference_replay`.
 */
export function createForkModuleHostCapabilities(
  backing: ForkModuleHostCapabilitiesBacking,
): ForkModuleHostCapabilities {
  // The opaque host side table: ordinal -> the reconstructed reference value.
  // The module addresses every reference by its ordinal; the real identity
  // never leaves the host.
  const rooted = new Map<number, unknown>();
  // slot (recipe_id + 1) -> the ordinal published there (for the read-back).
  const transitSlots = new Map<number, number>();
  let nextRef = 0;
  let resolved = 0;
  let lastErrno = 0;

  const fail = (errno: number): number => {
    lastErrno = errno;
    return 0;
  };

  const imports: Record<string, (...args: number[]) => number> = {
    host_begin_generation: (_pid: number): number => {
      lastErrno = 0;
      // A non-zero generation ordinal is the module's opaque handle for the
      // fork's host root scope. The bodies key identity off `backing` directly,
      // so the exact value only needs to be non-zero (0 == failure).
      return backing.generationId > 0 ? backing.generationId : fail(EINVAL);
    },
    host_resolve_externref: (_generation: number, brokerHandle: number): number => {
      if (brokerHandle === 0) return fail(EINVAL); // handles are 1..=0xffffffff
      let token: unknown;
      try {
        token = backing.tokens.materialize(brokerHandle);
      } catch {
        return fail(EINVAL);
      }
      nextRef += 1;
      rooted.set(nextRef, token);
      resolved += 1;
      lastErrno = 0;
      return nextRef;
    },
    host_transit_publish: (_generation: number, slot: number, value: number): number => {
      if (!backing.transit || !rooted.has(value)) return EINVAL;
      // slot is the canonical recipe_id + 1.
      backing.transit.publish(slot - 1, rooted.get(value));
      transitSlots.set(slot, value);
      lastErrno = 0;
      return 0;
    },
    host_transit_read: (_generation: number, slot: number): number => {
      if (!backing.transit) return fail(EINVAL);
      const ordinal = transitSlots.get(slot);
      if (ordinal === undefined) return fail(EINVAL); // non-null guard
      // Read back through the transit and confirm the SAME identity survived.
      const readValue = backing.transit.read(slot - 1);
      if (!Object.is(readValue, rooted.get(ordinal))) return fail(EINVAL);
      lastErrno = 0;
      return ordinal;
    },
    host_release_generation: (_generation: number): number => {
      // Drop this fork's ordinal roots. The shared externref token cache is
      // cleared by the JS reference path at process/exec teardown, not here.
      rooted.clear();
      transitSlots.clear();
      lastErrno = 0;
      return 0;
    },
    host_last_errno: (): number => lastErrno,
  };

  return {
    imports,
    rootedToken: (ordinal: number) => rooted.get(ordinal),
    get resolvedCount() {
      return resolved;
    },
  };
}
