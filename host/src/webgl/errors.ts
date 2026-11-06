import { nativeBatchActive } from "./native-batch.js";
export type GlErrorState = { errors: number[] };

export function recordGlError(owner: GlErrorState, error: number): void {
  if (error !== 0 && !owner.errors.includes(error)) owner.errors.push(error);
}

/** ES2's five error flags; no unadvertised desktop stack errors. */
export const GL_CLIENT_ERROR_MASK = 0x67;
export function mergeClientGlErrors(owner: GlErrorState, mask: number): void {
  for (let bit = 0; bit <= 6; bit++) {
    if (mask & (1 << bit)) recordGlError(owner, 0x500 + bit);
  }
}

/** A queued glGetError already returned this flag in the guest. Clear only
 * that flag at its original position in the command stream. */
export function consumeObservedGlError(owner: GlErrorState, mask: number): void {
  for (let i = owner.errors.length - 1; i >= 0; i--) {
    const bit = owner.errors[i]! - 0x500;
    if (bit >= 0 && bit <= 6 && (mask & (1 << bit))) owner.errors.splice(i, 1);
  }
}

/** Native error flags belong to the selected logical context. Drain before
 * losing that identity; errors from unowned host operations have no guest
 * owner and must not be inherited by the next context. */
export function captureNativeGlErrors(gl: WebGL2RenderingContext, owner: GlErrorState | null): void {
  if (nativeBatchActive(gl)) return;
  for (let i = 0; i < 32; i++) {
    const error = gl.getError();
    if (error === 0) return;
    if (!Number.isInteger(error) || error < 0 || error > 0xffff_ffff) {
      throw new Error("Invalid native GL error result");
    }
    if (owner) recordGlError(owner, error);
  }
  // A failed renderer cannot authorize a switch with errors still pending.
  throw new Error("Native GL error state did not clear");
}


// Optional preparations run synchronously inside exact cold error receivers.
// Provenance never follows a numeric OUT_OF_MEMORY flag and never applies to
// a different context merely because it reenters while a scope is active.
export type OptionalCpuPreparation={errors:number[];previous:OptionalCpuPreparation|null;active:boolean;refused:boolean};
let optionalCpuScope:OptionalCpuPreparation|null=null;
/** The query owns this receiver before entry. Linking an existing scope does
 * not allocate or leave a window with the guest's error receiver swapped. */
export function beginOptionalCpuPreparation(scope:OptionalCpuPreparation):void {
  if(scope.active)throw new Error("Optional CPU preparation receiver reentered");
  scope.previous=optionalCpuScope;scope.refused=false;scope.active=true;optionalCpuScope=scope;
}
export function optionalCpuPreparationRefused(scope:OptionalCpuPreparation):boolean{return scope.active&&scope.refused;}
export function endOptionalCpuPreparation(scope:OptionalCpuPreparation):void {
  if(optionalCpuScope!==scope||!scope.active)throw new Error("Optional CPU preparation scopes retired out of order");
  optionalCpuScope=scope.previous;scope.previous=null;scope.active=false;
}
/** Call only at a proven CPU metadata reservation failure, never for a native
 * GL flag, null native allocation, validation error, or failed restoration. */
export function recordCpuGlOutOfMemory(owner:GlErrorState):void {
  for(let scope=optionalCpuScope;scope;scope=scope.previous)if(scope.errors===owner.errors){scope.refused=true;return;}
  recordGlError(owner,0x505);
}
