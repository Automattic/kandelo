/**
 * Route an exception recipe to the activation that owns its tag.
 *
 * This is the surviving floor of the attic's 507-line `fork-exception-provider`,
 * and almost all of that file is gone rather than moved. What went:
 *
 * - `encodeFromSlot` and the whole probe/ingress-token machinery. The guest's
 *   unknown-tag import `__wpk_fork_ref_exn_broker_encode` is served by the
 *   fork-module now, which refuses it with `EOPNOTSUPP` (see its doc comment:
 *   an `exnref` cannot cross into a JS import, so the host could never have
 *   inspected one either). Nothing mints an ingress token any more.
 * - `readForkExceptionCodecDescriptor`. The module reads each activation's
 *   `kandelo.wpk_fork.exception_codec` section itself, seeded through
 *   `fm_set_activation_exception_codec`, and gates admission on it.
 * - `forkExceptionProviderFromInstance`'s seven wrapped guest exports.
 *   `__wpk_fork_exception_materialize` is drive slot 2; encode/decode are the
 *   guest's own generated code; `clear`/`abort` have no caller in the module
 *   path at all (see census 174).
 * - `buildForkExceptionImports`. Every one of those imports is either served by
 *   the module or is a member of `fork-guest-host-floor`.
 *
 * What is left is one question -- WHICH ACTIVATION owns this recipe -- and one
 * act only JavaScript can perform: calling activation B's exported thrower from
 * inside activation A's import frame, so the exception re-enters wasm with B's
 * tag rather than as a foreign JS throw (census 109).
 *
 * The owner is not the host's to remember. It is a field of the capture graph
 * the module decoded, read through `fm_decoded_node_field`.
 */

import type { ForkGuestExceptionThrower } from "./fork-guest-host-floor";
import { WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE as THROW_RECIPE } from "./generated/abi";

/**
 * `wire_node_kind` in `crates/fork-module/src/lib.rs`: 3 is `Exnref`.
 *
 * Checked before the owner is read because `fm_decoded_node_field` answers
 * `EINVAL` for a kind that carries no activation, and "not an exception" and
 * "a host-owned exception" must not arrive as the same error.
 */
const WIRE_NODE_KIND_EXNREF = 3;

/**
 * Recipe ids are node indices in the module's graph, and node 0 is never one:
 * the encoders return `>= 1` and reserve the top of the range. A poisoned
 * recipe (`-1`) from a refusing encoder therefore fails this rather than
 * reading some other node's owner.
 */
const MAX_RECIPE_ID = 0x7fff_fffe;

/** The two fields of the module's resident decoded graph this needs. */
export interface ForkExceptionGraph {
  /** Make the graph rooted at `moduleStateRoot` resident. */
  decodeReferenceGraph(moduleStateRoot: number): void;
  decodedNodeKind(index: number): number;
  decodedNodeModuleActivation(index: number): number;
}

/** Where an activation's guest instance is found. */
export interface ForkExceptionActivations {
  get(activationId: number): { readonly instance: WebAssembly.Instance } | undefined;
}

export class ForkExceptionBroker implements ForkGuestExceptionThrower {
  private resident = false;

  /**
   * Every dependency is a thunk, and not for elegance: this is built where the
   * guest import object is assembled, which is BEFORE the fork-module backend
   * and the activation set exist on the pthread path. The sealed arena root is
   * a thunk for a second reason -- it changes with every fork.
   */
  constructor(
    private readonly graph: () => ForkExceptionGraph,
    private readonly activations: () => ForkExceptionActivations,
    private readonly graphRoot: () => number,
    private readonly label: string,
  ) {}

  /**
   * A new graph exists; the next lookup must decode it.
   *
   * Separate from the decode itself so that a fork which throws no exception
   * pays nothing. Decoding is not free -- it walks the arena and abandons the
   * previous resident graph without freeing it (`abandon_resident`, deliberate:
   * a COW child inherits a graph it must not drop) -- so doing it per fork
   * rather than per need would add cost to every fork for a path most never
   * take.
   */
  invalidate(): void {
    this.resident = false;
  }

  /**
   * Throw the exception `recipeId` names, with its owning activation's tag.
   *
   * Never returns. A return would mean the guest's thrower did not throw, which
   * is a defect worth naming rather than a replay that silently continues past
   * an exception it never delivered.
   */
  throwRecipe(recipeId: number): never {
    if (!Number.isInteger(recipeId) || recipeId < 1 || recipeId > MAX_RECIPE_ID) {
      throw new RangeError(`${this.label}: ${recipeId} is not a recipe id`);
    }
    this.makeGraphResident();
    const kind = this.graph().decodedNodeKind(recipeId);
    if (kind !== WIRE_NODE_KIND_EXNREF) {
      throw new Error(
        `${this.label}: recipe ${recipeId} is node kind ${kind}, not an exception`);
    }
    let owner: number;
    try {
      owner = this.graph().decodedNodeModuleActivation(recipeId);
    } catch (error) {
      // The only exnref owner the module cannot report is one above `i32::MAX`,
      // and the only such owner the wire format defines is
      // `FORK_HOST_EXCEPTION_ACTIVATION_ID` (0xffff_ffff) -- a JavaScript
      // exception no activation's codec claimed. Materializing one needs the
      // externref payload edge of this node, which no module entry exposes, so
      // this is a real boundary and is reported as one.
      throw new Error(
        `${this.label}: exnref recipe ${recipeId} is host-owned; materializing `
          + `one needs its externref payload, which no fm_* entry exposes `
          + `(${String(error)})`);
    }
    const activation = this.activations().get(owner);
    if (!activation) {
      throw new Error(`${this.label}: recipe ${recipeId} is owned by activation `
        + `${owner}, which is not registered in this worker`);
    }
    const thrower = activation.instance.exports[THROW_RECIPE];
    if (typeof thrower !== "function") {
      throw new Error(`${this.label}: activation ${owner} exports no `
        + `${THROW_RECIPE}, so recipe ${recipeId} cannot be re-thrown `
        + `with its own tag`);
    }
    (thrower as (recipe: number) => void)(recipeId);
    throw new Error(`${this.label}: activation ${owner} returned from `
      + `${THROW_RECIPE}(${recipeId}) without throwing`);
  }

  /**
   * Throw the exception an ingress token names -- which nothing can mint.
   *
   * The token came from `encodeFromSlot`, whose guest import the fork-module
   * now serves and refuses (`__wpk_fork_ref_exn_broker_encode`, `EOPNOTSUPP`):
   * a capture cannot carry an exception whose tag no activation's codec claims,
   * and says so structurally by returning a poisoned recipe. So no token ever
   * exists, and the honest implementation of this half is to say which bound it
   * ran into rather than to keep a map that can never be filled. Lifting it is
   * F3's capture-side drive work, not a host change.
   */
  throwIngress(token: number): never {
    throw new Error(`${this.label}: no ingress token ${token} exists. The `
      + `module refuses __wpk_fork_ref_exn_broker_encode with EOPNOTSUPP, so `
      + `nothing mints one. See census 159.`);
  }

  private makeGraphResident(): void {
    if (this.resident) return;
    const root = this.graphRoot();
    if (root === 0) {
      throw new Error(`${this.label}: no sealed module-state arena, so no `
        + `graph can say which activation owns an exception recipe`);
    }
    this.graph().decodeReferenceGraph(root);
    this.resident = true;
  }
}
