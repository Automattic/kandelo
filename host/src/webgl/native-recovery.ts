import { checkedGlCall, type CheckedGlOwner } from "./program-objects.js";
import { recordGlError } from "./errors.js";

/** Only native handles/scalars enter a persistent inverse, never guest data or
 * callbacks whose lexical environment could retain a whole binding. */
export type NativeCall =
  | ["activeTexture", number]
  | ["bindTexture", number, WebGLTexture | null]
  | ["bindFramebuffer", number, WebGLFramebuffer | null]
  | ["bindRenderbuffer", number, WebGLRenderbuffer | null]
  | ["bindBuffer", number, WebGLBuffer | null]
  | ["framebufferTexture2D", number, number, number, WebGLTexture | null, number]
  | ["framebufferRenderbuffer", number, number, number, WebGLRenderbuffer | null]
  | ["vertexAttribPointer", number, number, number, boolean, number, number];
export type NativeInverse = { owner: CheckedGlOwner; groups: NativeCall[][] };
export type NativeChange = { apply(): boolean; restore: NativeInverse };
type Repair = {
  lifetime: object;
  restores: NativeInverse[];
  attempted: number;
  pending: boolean;
  replaying: boolean;
  owner: CheckedGlOwner;
};
const repairs = new WeakMap<WebGL2RenderingContext, Repair>();

export function invokeNativeCall(gl: WebGL2RenderingContext, call: NativeCall): void {
  const [method, ...args] = call;
  Reflect.apply(gl[method], gl, args);
}

/** A selector must accept before dependent calls run; independent groups
 * (such as read/draw restoration) are attempted even after another fails. */
function restoreInverse(inverse: NativeInverse): boolean {
  let accepted = true;
  for (const group of inverse.groups) for (const call of group) {
    if (checkedGlCall(inverse.owner, () => invokeNativeCall(inverse.owner.gl!,call))) continue;
    accepted = false; break;
  }
  return accepted;
}

export function hasNativeRepair(gl: WebGL2RenderingContext): boolean {
  return repairs.get(gl)?.pending === true;
}

export function repairNativeState(gl: WebGL2RenderingContext): boolean {
  const repair = repairs.get(gl);
  if (!repair?.pending) return true;
  if (repair.replaying) return false;
  repair.replaying = true;
  let restored = true;
  try {
    if (gl.isContextLost?.()) return false;
    for (let i = repair.attempted - 1; i >= 0; i--) restored = restoreInverse(repair.restores[i]) && restored;
    if (restored) repairs.delete(gl);
    return restored;
  } catch { recordGlError(repair.owner, 0x502); return false; }
  finally { repair.replaying = false; }
}

/** Reserve the repair record before native mutation. A failed inverse remains
 * reachable and fences the entire physical context until it can be replayed. */
export function applyNativeChanges(b: CheckedGlOwner & { shadow: object }, changes: NativeChange[]): boolean {
  const gl = b.gl;
  if (!gl || repairs.has(gl)) return false;
  let repair: Repair;
  try {
    repair = { lifetime:b.shadow, restores:changes.map(change => change.restore),
      attempted:0, pending:false, replaying:false, owner:nativeOwner(b) };
    repairs.set(gl,repair);
  } catch { recordGlError(b,0x505); return false; }
  for (const change of changes) {
    repair.attempted++;
    let accepted = false;
    try { accepted = change.apply(); }
    catch { recordGlError(b,0x502); }
    if (accepted) continue;
    repair.pending = true;
    repairNativeState(gl);
    return false;
  }
  repairs.delete(gl);
  return true;
}

/** These inverses concern retiring context-local selectors/containers, not
 * shared storage contents. Teardown deletes the containers; they must never
 * be revived by a later owner's repair. Muxer retirement precedes this call. */
export function retireNativeRepair(gl: WebGL2RenderingContext, lifetime: object): void {
  if (repairs.get(gl)?.lifetime === lifetime) repairs.delete(gl);
}

export function nativeOwner(b: CheckedGlOwner): CheckedGlOwner {
  return {gl:b.gl, errors:b.errors};
}
export function nativeInverse(owner: CheckedGlOwner, ...groups: NativeCall[][]): NativeInverse {
  return {owner:nativeOwner(owner),groups};
}
