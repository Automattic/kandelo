/**
 * One native submission point for GLES draws. ES 2.0 state that WebGL 2
 * cannot hold directly is realized here for the duration of one draw, and the
 * shadow-derived native state is restored through the journalled inverse.
 */
import type { GlBinding } from "./registry.js";
import { applyNativeChanges, nativeInverse } from "./native-recovery.js";
import { checkedGlCall } from "./program-objects.js";
import { depthRangeReversed, reversedDepthExecutable, synchronizeReversedDepthTwin } from "./reversed-depth.js";

export type GlesDraw = {
  /** Issue the complete native draw against the current native state. */
  issue(): void;
  /** The draw rasterizes nothing (count 0): no private executable needed. */
  empty?: boolean;
};

export function issueGlesDraw(b: GlBinding, draw: GlesDraw): boolean {
  const gl = b.gl!;
  const twin = !draw.empty && depthRangeReversed(b.shadow.depthRange) ? reversedDepthExecutable(b) : undefined;
  if (twin === null) return false;
  if (twin === undefined) return checkedGlCall(b, draw.issue);
  // The guest executable stays installed in every logical record; only this
  // draw runs its reversed-depth twin (see reversed-depth.ts).
  const primary = b.currentProgram;
  return applyNativeChanges(b, [
    { apply: () => checkedGlCall(b, () => gl.useProgram(twin)) && synchronizeReversedDepthTwin(b, twin),
      restore: nativeInverse(b) },
    { apply: () => checkedGlCall(b, draw.issue), restore: nativeInverse(b) },
  ], { finalizer: nativeInverse(b, [["useProgram", primary]]) });
}
