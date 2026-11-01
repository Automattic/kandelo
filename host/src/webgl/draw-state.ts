/**
 * One native submission point for GLES draws. ES 2.0 state that WebGL 2
 * cannot hold directly is realized here for the duration of one draw, and the
 * shadow-derived native state is restored through the journalled inverse.
 *
 * Reversed depth ranges, depth-texture sampling and constant color/alpha
 * blend factor pairs run a private executable (reversed-depth.ts).
 *
 * Separate stencil state: ES 2.0 section 4.1.4 gives front- and back-facing
 * primitives independent stencil ref, value mask and write mask. WebGL (1.0
 * section 6.11, inherited by WebGL 2) rejects a draw when those differ. When
 * only one face's state can reach the stencil buffer, the other face mirrors
 * those three values for the draw: points and lines are front-facing, a
 * disabled test or a framebuffer without stencil bits never uses them, user
 * culling can remove one face, and values that agree after clamping the ref
 * and masking to the stencil bits behave identically. Otherwise triangles are
 * drawn in face passes: native culling selects one face per pass while that
 * face's stencil state is installed. Pass j covers triangles j-1 and j and
 * passes alternate front/back, so each triangle meets its two passes back to
 * back and is rasterized, by exactly one of them, before every later
 * triangle: primitive order is preserved. Passes reuse the guest's primitive
 * mode, keeping each triangle's own vertex order (strips start on an even
 * vertex or behind a zero-area lead-in, so parity is unchanged); zero-area
 * triangles produce no fragments. One draw under RASTERIZER_DISCARD first
 * applies WebGL's whole-draw validation, so a rejected draw has no effect.
 */
import type { GlBinding } from "./registry.js";
import { applyNativeChanges, nativeInverse, reserveNativeRetirement, retireNativeRetirement, type NativeCall, type NativeChange, rethrowNativeGlFault } from "./native-recovery.js";
import { allocateNativeBuffer } from "./buffer-storage.js";
import { checkedGlCall, checkedGlCallAfterClean, checkedGlSequence, recordGlError } from "./program-objects.js";
import { drawVariantExecutable, synchronizeReversedDepthTwin } from "./reversed-depth.js";
import type { GlStencilFaceState } from "./shadow.js";
import { prepareDrawTarget } from "./opaque-alpha.js";
import { robustVertexDraw } from "./robust-access.js";

const FRONT = 0x0404, BACK = 0x0405, FRONT_AND_BACK = 0x0408;
const CULL_FACE = 0x0b44, RASTERIZER_DISCARD = 0x8c89, ELEMENT = 0x8893, UNSIGNED_INT = 0x1405;
const TRIANGLES = 4, TRIANGLE_STRIP = 5;

export type GlesDraw = {
  mode: number;
  /** Issue the complete native draw against the current native state. */
  issue(): void;
  /** The draw rasterizes nothing (count 0). */
  empty?: boolean;
  /** The draw's vertex indices in submission order (for face passes). */
  vertices(): ArrayLike<number> | null;
  /** False when the caller does not use the draw's acceptance. A draw that
   * installs no private state is then issued as a plain command, like
   * Clear: a native error stays pending in the context's error state for
   * the next drain instead of costing two getError calls per draw. */
  observed?: boolean;
  /** The caller just checked the native error state clean (its own setup
   * step), so the draw's check needs no entry drain. */
  cleanEntry?: boolean;
  /** The highest vertex index the draw reads (robust buffer access). */
  maxVertex?: number;
};

type StencilPlan = { kind: "none" } | { kind: "mirror"; face: number } | { kind: "split" };
const NO_STENCIL_PLAN: StencilPlan = Object.freeze({ kind: "none" });

function sameStencilSelectors(a: GlStencilFaceState, b: GlStencilFaceState, bits?: number): boolean {
  if (bits === undefined) return a.ref === b.ref && a.valueMask === b.valueMask && a.writeMask === b.writeMask;
  // ES 2.0 section 4.1.4: ref clamps to [0, 2^s - 1]; masks act on s bits.
  const max = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
  const ref = (value: number) => Math.min(Math.max(value, 0), max);
  return ref(a.ref) === ref(b.ref) && ((a.valueMask & max) >>> 0) === ((b.valueMask & max) >>> 0)
    && ((a.writeMask & max) >>> 0) === ((b.writeMask & max) >>> 0);
}

function stencilPlan(b: GlBinding, draw: GlesDraw): StencilPlan | null {
  const s = b.shadow, { front, back } = s.stencil;
  if (sameStencilSelectors(front, back)) return NO_STENCIL_PLAN;
  const triangles = draw.mode >= TRIANGLES && draw.mode <= 6;
  if (!s.stencilTestEnabled || !triangles || draw.empty) return { kind: "mirror", face: FRONT };
  if (s.cullFaceEnabled) return { kind: "mirror", face: s.cullFace === FRONT ? BACK : FRONT };
  let bits = 0;
  if (!checkedGlCall(b, () => { bits = Number(b.gl!.getParameter(0x0d57)); })) return null;
  if (!(bits > 0) || sameStencilSelectors(front, back, bits)) return { kind: "mirror", face: FRONT };
  return { kind: "split" };
}

/** Native stencil selectors with `face`'s ref/value mask/write mask on both
 * faces; each face keeps its own function (and operations). */
function mirroredStencil(b: GlBinding, face: number): NativeCall[] {
  const { front, back } = b.shadow.stencil, source = face === FRONT ? front : back;
  return [["stencilFuncSeparate", FRONT, front.func, source.ref, source.valueMask],
    ["stencilFuncSeparate", BACK, back.func, source.ref, source.valueMask],
    ["stencilMaskSeparate", FRONT_AND_BACK, source.writeMask]];
}

function stencilRestore(b: GlBinding): NativeCall[][] {
  const { front, back } = b.shadow.stencil;
  return [[["stencilFuncSeparate", FRONT, front.func, front.ref, front.valueMask]],
    [["stencilFuncSeparate", BACK, back.func, back.ref, back.valueMask]],
    [["stencilMaskSeparate", FRONT, front.writeMask]], [["stencilMaskSeparate", BACK, back.writeMask]]];
}

function invoke(b: GlBinding, calls: NativeCall[]): boolean {
  const gl = b.gl!;
  return checkedGlSequence(b, calls.map(([method, ...args]) => () => {
    Reflect.apply(gl[method] as (...a: unknown[]) => void, gl, args);
  }));
}

/** DrawArrays vertex indices first..first+count-1. */
export function sequentialVertices(first: number, count: number): Uint32Array {
  return Uint32Array.from({ length: Math.max(0, count) }, (_, i) => first + i);
}

type Pass = { face: number; offset: number; count: number };

/** Index data for the alternating face passes, in the guest's mode. */
export function facePasses(mode: number, vertices: ArrayLike<number>): { indices: Uint32Array; passes: Pass[] } {
  const count = vertices.length;
  const triangles = mode === TRIANGLES ? Math.floor(count / 3) : Math.max(0, count - 2);
  const sequences: number[][] = [];
  for (let j = 0; triangles > 0 && j <= triangles; j++) {
    const first = Math.max(0, j - 1), last = Math.min(triangles - 1, j);
    const sequence: number[] = [];
    if (mode === TRIANGLES) for (let i = first * 3; i < last * 3 + 3; i++) sequence.push(vertices[i]);
    else if (mode === TRIANGLE_STRIP) {
      // An odd first triangle stays odd behind a zero-area lead-in.
      if (first % 2) sequence.push(vertices[first]);
      for (let i = first; i <= last + 2; i++) sequence.push(vertices[i]);
    } else {
      sequence.push(vertices[0]);
      for (let i = first + 1; i <= last + 2; i++) sequence.push(vertices[i]);
    }
    sequences.push(sequence);
  }
  const indices = new Uint32Array(sequences.reduce((sum, sequence) => sum + sequence.length, 0));
  const passes: Pass[] = [];
  let at = 0;
  sequences.forEach((sequence, j) => {
    indices.set(sequence, at);
    passes.push({ face: j % 2 ? BACK : FRONT, offset: at * 4, count: sequence.length });
    at += sequence.length;
  });
  return { indices, passes };
}

export function issueGlesDraw(b: GlBinding, draw: GlesDraw): boolean {
  const gl = b.gl!;
  const stencil = stencilPlan(b, draw);
  if (!stencil) return false;
  // Reversed depth ranges, depth-texture lookups and folded constant blend
  // factors (blend-constant.ts) run a private variant.
  const twin = draw.empty ? undefined : drawVariantExecutable(b);
  if (twin === null) return false;
  // RGB color storage kept as RGBA: the native alpha is never written;
  // sampled siblings of the storage see the write.
  prepareDrawTarget(b);
  // Robust buffer access contexts keep every vertex fetch in range
  // (robust-access.ts); others pay this one flag test.
  const robust = b.robustAccess && !draw.empty ? robustVertexDraw(b, robustMaxVertex(b, draw)) : undefined;
  if (robust === null) return false;
  if (twin === undefined && stencil.kind === "none" && !robust) {
    if (draw.cleanEntry) return checkedGlCallAfterClean(b, draw.issue);
    if (draw.observed !== false) return checkedGlCall(b, draw.issue);
    draw.issue();
    return true;
  }

  const changes: NativeChange[] = [], finalizer: NativeCall[][] = [];
  if (robust) { changes.push(...robust.changes); finalizer.push(...robust.finalizer); }
  if (twin) {
    // The guest executable stays installed in every logical record; only
    // this draw runs its private variant (reversed depth, depth sampling).
    changes.push({ apply: () => checkedGlCall(b, () => gl.useProgram(twin)) && synchronizeReversedDepthTwin(b, twin),
      restore: nativeInverse(b) });
    finalizer.push([["useProgram", b.currentProgram]]);
  }
  if (stencil.kind !== "none") finalizer.push(...stencilRestore(b));
  if (stencil.kind === "none") changes.push({ apply: () => checkedGlCall(b, draw.issue), restore: nativeInverse(b) });
  else if (stencil.kind === "mirror") {
    changes.push({ apply: () => invoke(b, mirroredStencil(b, stencil.face)), restore: nativeInverse(b) });
    changes.push({ apply: () => checkedGlCall(b, draw.issue), restore: nativeInverse(b) });
  } else return splitFaces(b, draw, changes, finalizer);
  return applyNativeChanges(b, changes, { finalizer: nativeInverse(b, ...finalizer) });
}

function robustMaxVertex(b: GlBinding, draw: GlesDraw): number {
  if (draw.maxVertex !== undefined) return draw.maxVertex;
  let vertices: ArrayLike<number> | null = null;
  if (!checkedGlCall(b, () => { vertices = draw.vertices(); }) || !vertices) return 0;
  const list = vertices as ArrayLike<number>;
  let max = 0;
  for (let i = 0; i < list.length; i++) if (list[i] > max) max = list[i];
  return max;
}

function splitFaces(b: GlBinding, draw: GlesDraw, changes: NativeChange[], finalizer: NativeCall[][]): boolean {
  const gl = b.gl!, s = b.shadow;
  let element: WebGLBuffer | null = null, vertices: ArrayLike<number> | null = null;
  if (!checkedGlCall(b, () => { element = gl.getParameter(0x8895) as WebGLBuffer | null; vertices = draw.vertices(); }) || !vertices)
    return false;
  let plan: ReturnType<typeof facePasses>;
  try { plan = facePasses(draw.mode, vertices); }
  catch (caught) { rethrowNativeGlFault(caught); recordGlError(b, 0x505); return false; }
  const retirement = reserveNativeRetirement(b, [["deleteBuffer", null]]);
  if (!retirement) return false;
  try {
    finalizer.push([["disable", RASTERIZER_DISCARD]], [["cullFace", s.cullFace]],
      [[s.cullFaceEnabled ? "enable" : "disable", CULL_FACE]], [["bindBuffer", ELEMENT, element]]);
    // Whole-draw validation (attribute ranges, framebuffer, program) with no
    // rasterization: a rejected draw stops here with its WebGL error.
    changes.push({ apply: () => invoke(b, [...mirroredStencil(b, FRONT), ["enable", RASTERIZER_DISCARD]]) &&
      checkedGlCall(b, draw.issue) && invoke(b, [["disable", RASTERIZER_DISCARD]]), restore: nativeInverse(b) });
    changes.push({ apply: () => {
      if (!plan.passes.length) return true;
      const temporary = allocateNativeBuffer(b, retirement);
      if (!temporary || !checkedGlSequence(b, [() => gl.bindBuffer(ELEMENT, temporary),
        () => gl.bufferData(ELEMENT, plan.indices, 0x88e0), () => gl.enable(CULL_FACE)])) return false;
      for (const pass of plan.passes) {
        if (!invoke(b, [...mirroredStencil(b, pass.face), ["cullFace", pass.face === FRONT ? BACK : FRONT]]) ||
            !checkedGlCall(b, () => gl.drawElements(draw.mode, pass.count, UNSIGNED_INT, pass.offset))) return false;
      }
      return true;
    }, restore: nativeInverse(b) });
    return applyNativeChanges(b, changes, { finalizer: nativeInverse(b, ...finalizer) });
  } finally { retireNativeRetirement(retirement); }
}
