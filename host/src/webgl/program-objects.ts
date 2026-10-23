// Deferred shader/program ownership adapted from Brandon Payton's
// generic-kms-gles-runtime, retaining main's native-object shadow layout.
import type { GlBinding } from "./registry.js";

export function recordGlError(b: GlBinding, error: number): void {
  if (error !== 0 && !b.errors.includes(error)) b.errors.push(error);
}

/** Keep previously pending errors observable, then commit bookkeeping only
 * if this native call is accepted. Driver rejection must leave state intact. */
export function checkedGlCall(b: GlBinding, call: () => void): boolean {
  const gl = b.gl;
  if (!gl) return false;
  try {
    let cleared = false;
    for (let i = 0; i < 32; i++) {
      const error = gl.getError();
      if (error === 0) { cleared = true; break; }
      recordGlError(b, error);
    }
    if (!cleared) return false;
    call();
    const error = gl.getError();
    recordGlError(b, error);
    return error === 0;
  } catch {
    recordGlError(b, 0x502); // INVALID_OPERATION
    return false;
  }
}

export function finalizeShader(b: GlBinding, name: number): void {
  if (!b.shaderDeletePending.has(name)) return;
  for (const attached of b.programShaders.values()) if (attached.has(name)) return;
  b.shaderDeletePending.delete(name);
  b.shaders.delete(name);
}

export function finalizeProgram(b: GlBinding, name: number): void {
  if (!b.programDeletePending.has(name)) return;
  const program = b.programs.get(name);
  if (program === b.currentProgram) return;
  if (program && b.gl && !checkedGlCall(b, () => b.gl!.deleteProgram(program))) return;
  b.programDeletePending.delete(name);
  b.programs.delete(name);
  const shaders = b.programShaders.get(name);
  b.programShaders.delete(name);
  for (const [location, owner] of b.uniformLocationPrograms) {
    if (owner !== name) continue;
    b.uniformLocationPrograms.delete(location);
    b.uniformLocations.delete(location);
  }
  if (shaders) for (const shader of shaders) finalizeShader(b, shader);
}

export function useProgramIfAccepted(b: GlBinding, name: number): void {
  const program = name === 0 ? null : b.programs.get(name);
  if (program === undefined) {
    recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
    return;
  }
  const previous = b.currentProgram;
  if (!checkedGlCall(b, () => b.gl!.useProgram(program))) return;
  b.currentProgram = program;
  b.shadow.currentProgram = program;
  if (previous !== program) {
    for (const [oldName, object] of b.programs) {
      if (object === previous) { finalizeProgram(b, oldName); break; }
    }
  }
}
