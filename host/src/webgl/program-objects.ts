import { isKernelExportFailure } from "../kernel-entry-gate.js";
// Deferred shader/program ownership adapted from Brandon Payton's
// generic-kms-gles-runtime, retaining main's native-object shadow layout.
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { recordGlError } from "./errors.js";
export { recordGlError } from "./errors.js";

/** Keep previously pending errors observable, then commit bookkeeping only
 * if this native call is accepted. Driver rejection must leave state intact. */
export type CheckedGlOwner = Pick<GlBinding, "gl" | "errors">;
export function checkedGlCall(b: CheckedGlOwner, call: () => void): boolean {
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
  } catch (error) { if(isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502); // INVALID_OPERATION
    return false;
  }
}

export function finalizeShader(b: GlBinding, name: number): void {
  if (!b.shaderDeletePending.has(name)) return;
  for (const attached of b.programShaders.values()) if (attached.has(name)) return;
  const shader = b.shaders.get(name);
  if (shader && !checkedGlCall(b, () => b.gl!.deleteShader(shader))) return;
  b.shaderDeletePending.delete(name);
  if (shader) b.shaderSources.delete(shader);
  for (const member of b.objects.members) if (member.shaderUpload?.shader === shader) member.shaderUpload = null;
  b.shaders.delete(name);
}

export function finalizeProgram(b: GlBinding, name: number): void {
  if (!b.programDeletePending.has(name)) return;
  const program = b.programs.get(name);
  if ([...b.objects.members].some(member => name === currentProgramName(member)) || (program && b.programQueryPins.has(program))) return;
  finishProgramDeletion(b,name,program);
}

function finishProgramDeletion(b: GlBinding, name: number, program: WebGLProgram | undefined): boolean {
  if (program && b.gl && !deleteUnusedNativeProgram(b, program)) return false;
  b.programDeletePending.delete(name);
  b.programs.delete(name);
  const shaders = b.programShaders.get(name);
  b.programShaders.delete(name);
  b.programAttributeBindings.delete(name);
  invalidateProgramLocations(b, name);
  if (shaders) for (const shader of shaders) finalizeShader(b, shader);
  return true;
}

function invalidateProgramLocations(b: GlBinding, name: number): void {
  for (const [location, record] of b.uniformLocationRecords) {
    if (record.program !== name) continue;
    if (record.references > 0) record.state = "invalid";
    else b.uniformLocationRecords.delete(location);
  }
}

export function currentProgramName(b: GlBinding): number {
  if (!b.currentProgram) return 0;
  if (b.currentProgramId !== 0) return b.currentProgramId;
  for (const [name, object] of b.programs) if (object === b.currentProgram) return name;
  return 0;
}

export function releaseRetainedExecutable(b: GlBinding, program: WebGLProgram | null): void {
  if (!program || b.programQueryPins.has(program) || [...b.objects.members].some(member => program === member.currentProgram)) return;
  for (const object of b.programs.values()) if (object === program) return;
  deleteUnusedNativeProgram(b, program);
}

function deleteUnusedNativeProgram(b: GlBinding, program: WebGLProgram): boolean {
  return checkedGlCall(b, () => {
    // No logical owner retains this executable. Release a stale physical
    // installation too, so native deletion can complete during teardown.
    if (b.gl!.getParameter(0x8b8d) === program) b.gl!.useProgram(null);
    b.gl!.deleteProgram(program);
  });
}

/** Stable generation cell; advancing an accepted link needs no allocation. */
export function programLinkGeneration(b: GlBinding, program: WebGLProgram): { value: number } {
  let generation=b.programLinkGenerations.get(program);
  if(!generation) {generation={value:0};b.programLinkGenerations.set(program,generation);}
  return generation;
}

/** A current GLES executable survives failed relinking. A native WebGL
 * program cannot provide that contract, so link into a separate native
 * object while the prior executable is installed. The logical object maps
 * to the latest attempt, independently of the executable used for draws. */
export function linkProgramRetainingExecutable(b: GlBinding, name: number): void {
  const gl = b.gl;
  const previous = b.programs.get(name);
  if (!gl || !previous) {
    recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
    return;
  }
  const currentName = currentProgramName(b);
  const installed = b.currentProgram;
  let program = previous;
  if (b.programQueryPins.has(previous) || [...b.objects.members].some(member => previous === member.currentProgram)) {
    let candidate: WebGLProgram | null = null;
    const allocated = checkedGlCall(b, () => { candidate = gl.createProgram(); });
    if (!allocated || !candidate) {
      if (candidate) gl.deleteProgram(candidate);
      if (!candidate) recordGlError(b, 0x505); // OUT_OF_MEMORY
      return;
    }
    program = candidate;
    const prepared = checkedGlCall(b, () => {
      for (const shaderName of b.programShaders.get(name) ?? []) {
        const shader = b.shaders.get(shaderName);
        if (shader) gl.attachShader(program, shader);
      }
      for (const [attribute, index] of b.programAttributeBindings.get(name) ?? []) {
        gl.bindAttribLocation(program, index, attribute);
      }
    });
    if (!prepared) { gl.deleteProgram(program); return; }
  }
  let generation: {value:number};
  try { generation=programLinkGeneration(b,program); }
  catch (error) { if(isKernelExportFailure(error)) throw error; recordGlError(b,0x505); if(program!==previous) gl.deleteProgram(program);return; }
  if(generation.value>=Number.MAX_SAFE_INTEGER) {recordGlError(b,0x505);if(program!==previous)gl.deleteProgram(program);return;}
  if (!checkedGlCall(b, () => gl.linkProgram(program))) {
    if (program !== previous) gl.deleteProgram(program);
    return;
  }
  generation.value++;
  if (currentName === name) b.currentProgramId = name;
  b.programs.set(name, program);
  let linked = false;
  if (checkedGlCall(b, () => { linked = !!gl.getProgramParameter(program, 0x8b82); }) && linked) {
    invalidateProgramLocations(b, name);
    if (currentName === name) {
      if (checkedGlCall(b, () => gl.useProgram(program))) {
        b.shadow.currentProgram = b.currentProgram = program;
      }
    }
  }
  for (const retired of new Set([previous, installed])) releaseRetainedExecutable(b, retired);
}

export function useProgramIfAccepted(b: GlBinding, name: number): void {
  const program = name === 0 ? null : b.programs.get(name);
  if (program === undefined) {
    recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
    return;
  }
  const previous = b.currentProgram;
  const previousName = currentProgramName(b);
  const wasRetained = previous !== null && b.programs.get(previousName) !== previous;
  if (!checkedGlCall(b, () => b.gl!.useProgram(program))) return;
  b.currentProgram = program;
  b.currentProgramId = name;
  b.shadow.currentProgram = program;
  if (previous !== program) {
    if (previousName !== 0) finalizeProgram(b, previousName);
    if (wasRetained) releaseRetainedExecutable(b, previous);
  }
}

/** A query owns its exact accepted context and native executable, independently
 * of the live registry slot. Releasing native custody is retryable. */
export class GlProgramQueryPin {
  private released = false;
  private readonly objects:GlBinding["objects"];
  private constructor(private execution: GlContextExecutionLease | null,
      readonly binding: GlBinding, readonly name: number, readonly program: WebGLProgram) {this.objects=binding.objects;}

  static acquire(execution: GlContextExecutionLease, name: number): GlProgramQueryPin | null {
    const b=execution.binding, program=b.programs.get(name);
    if(!program) {recordGlError(b,b.shaders.has(name)?0x502:0x501);return null;}
    const count=b.programQueryPins.get(program)??0;
    if(count>=Number.MAX_SAFE_INTEGER) {recordGlError(b,0x505);return null;}
    const retained=execution.clone();
    if(!retained) {recordGlError(b,0x505);return null;}
    try {
      const pin=new GlProgramQueryPin(retained,b,name,program);
      programLinkGeneration(b,program);
      b.programQueryPins.set(program,count+1);
      return pin;
    } catch (error) { if(isKernelExportFailure(error)) throw error;
      // The caller still owns its execution lease, so this cannot retire it.
      retained.release();recordGlError(b,0x505);return null;
    }
  }

  release(): boolean {
    const b=this.binding, program=this.program;
    if(!this.released) {
      if(b.objects!==this.objects) return false;
      const count=b.programQueryPins.get(program);
      if(!count) throw new Error("Uniform query executable pin lost");
      if(count>1) b.programQueryPins.set(program,count-1);
      else {
        const named=b.programs.get(this.name)===program;
        const current=[...b.objects.members].some(member=>member.currentProgram===program);
        if(named && b.programDeletePending.has(this.name) && !current) {
          if(!finishProgramDeletion(b,this.name,program)) return false;
        } else if(!named && !current && !deleteUnusedNativeProgram(b,program)) return false;
        b.programQueryPins.delete(program);
      }
      this.released=true;
    }
    if(this.execution && !this.execution.release()) return false;
    this.execution=null;
    return true;
  }
}
