import { predictsNativeCalls, predictedNativeCalls, observeBatchNativeError } from "./native-batch.js";
import { copyExternalSamplers, recordLinkedExternalSamplers } from "./external-texture.js";
import { isKernelExportFailure } from "../kernel-entry-gate.js";
// Deferred shader/program ownership adapted from Brandon Payton's
// generic-kms-gles-runtime, retaining main's native-object shadow layout.
import type { GlBinding, GlContextExecutionLease } from "./registry.js";
import { recordGlError } from "./errors.js";
import { createShaderError, useProgramError } from "./es2-validation.js";
import { nativeGlFault, NativeGlFault, rendererEverLost, reserveNativeRetirement, retireNativeRetirement, transferNativeRetirement,
  type NativeDeletion, type NativeRetirement, rethrowNativeGlFault } from "./native-recovery.js";
export { recordGlError } from "./errors.js";
import { recordLinkedProgram, releaseReversedDepthTwin } from "./reversed-depth.js";
import { aliasedAttributeLocation, attributeAliasLayout, linkAliasedExecutable } from "./attribute-aliasing.js";
import { nativeInterfaceName, prepareLinkLanguages, programNativeName, recordProgramLanguage } from "./essl3-translation.js";
import { noteProgramRelinked } from "./uniform-layout.js";

/** Inside a guest execution batch, validation has already decided acceptance.
 * Private host allocations outside that owner still need exact native checks
 * before publishing their handles; their errors cannot consume batch errors. */
export type CheckedGlOwner = Pick<GlBinding, "gl" | "errors">;
export function checkedGlCall(b: CheckedGlOwner, call: () => void, policy?: "cleanup"): boolean {
  if (policy !== "cleanup" && predictsNativeCalls(b)) return predictedNativeCalls([call]);
  const gl = b.gl;
  if (!gl) return false;
  try {
    let cleared = false;
    for (let i = 0; i < 32; i++) {
      const error = gl.getError();
    observeBatchNativeError(gl, error);
      if (error === 0) { cleared = true; break; }
      recordGlError(b, error);
    }
    if (!cleared) return false;
    call();
    const error = gl.getError();
    if (policy !== "cleanup") observeBatchNativeError(gl, error);
    recordGlError(b, error);
    return error === 0;
  } catch (error) { rethrowNativeGlFault(error); if(isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502); // INVALID_OPERATION
    return false;
  }
}

/** Shader and program names share one namespace. Deferred-deletion names
 * remain valid while their actual objects are retained in these shared maps. */
export function requireProgramObject(b: GlBinding, name: number): WebGLProgram | null {
  const program = name === 0 ? undefined : b.programs.get(name);
  if (!program) recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501);
  return program ?? null;
}
export function requireShaderObject(b: GlBinding, name: number): WebGLShader | null {
  const shader = name === 0 ? undefined : b.shaders.get(name);
  if (!shader) recordGlError(b, b.programs.has(name) ? 0x502 : 0x501);
  return shader ?? null;
}

/** Location queries require the named program's current accepted link state;
 * an older executable retained for drawing does not make a failed relink valid. */
export function linkedProgramForQuery(b: GlBinding, name: number): WebGLProgram | null {
  const program = requireProgramObject(b, name);
  if (!program) return null;
  let linked = false;
  if (!checkedGlCall(b, () => { linked = !!b.gl!.getProgramParameter(program, 0x8b82); })) return null;
  if (!linked) { recordGlError(b, 0x502); return null; }
  return program;
}

/** ES 2.0 section 2.10.4: an inactive or "gl_"-prefixed attribute name is -1
 * without an error; only the program can fail the lookup. Attributes are
 * plain identifiers (no arrays or structures), so any other spelling is
 * inactive, and WebGL's INVALID_VALUE for its character set is never
 * imported. WebGL also limits lookup strings to 256 characters (WebGL 1.0
 * "Maximum Uniform and Attribute Location Lengths"). A long name absent
 * from actual reflection is inactive regardless of its length; an active
 * one still asks the engine, whose limit error is the real boundary. */
export function attributeLocation(b: GlBinding, program: WebGLProgram, text: string): number | null {
  if (text.startsWith("gl_") || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(text)) return -1;
  // Aliasing executables answer from the guest's declarations and bindings.
  const aliased = aliasedAttributeLocation(program, text);
  if (aliased !== undefined) return aliased;
  const gl = b.gl!;
  if (text.length > 256) {
    let count = 0, found = false;
    if (!checkedGlCall(b, () => { count = Number(gl.getProgramParameter(program, 0x8b89)); })) return null;
    for (let index = 0; index < count && !found; index++) {
      let info: WebGLActiveInfo | null = null;
      if (!checkedGlCall(b, () => { info = gl.getActiveAttrib(program, index); })) return null;
      found = (info as WebGLActiveInfo | null)?.name === programNativeName(program, text);
    }
    if (!found) return -1;
  }
  let location = -1;
  // A translated program's attribute has its native name (essl3-translation.ts).
  if (!checkedGlCall(b, () => { location = gl.getAttribLocation(program, programNativeName(program, text)); })) return null;
  return location;
}

/** Each accepted guest shader's type (VERTEX_SHADER or FRAGMENT_SHADER), so
 * AttachShader's one-shader-per-type rule is predicted (es2-validation.ts).
 * Keyed by the native object, which EGL share groups share. */
const shaderTypes = new WeakMap<WebGLShader, number>();
/** Native programs whose last link the host saw fail, so UseProgram's
 * link-status rule is predicted for them (es2-validation.ts). A program the
 * host never saw linked is left to the renderer (native-predictions.ts). */
const failedLinks = new WeakSet<WebGLProgram>();
export function shaderType(shader: WebGLShader | undefined): number | undefined {
  return shader ? shaderTypes.get(shader) : undefined;
}

/** Empty native receivers are reserved before creation. Even a native call
 * which returns a handle and an error leaves that handle owned for rollback. */
export function createShaderIfAccepted(b: GlBinding, type: number, name: number): void {
  if (!b.gl) return;
  const typeError = createShaderError(type);
  if (typeError) { recordGlError(b, typeError); return; }
  if (!name || b.shaders.has(name) || b.programs.has(name)) {
    recordGlError(b, 0x502); return;
  }
  const receiver = reserveNativeRetirement(b, [["deleteShader", null]]);
  if (!receiver) return;
  try {
    const accepted = checkedGlCall(b, () => { receiver.calls[0][1] = b.gl!.createShader(type); });
    const shader = receiver.calls[0][1] as WebGLShader | null;
    if (!accepted) return;
    if (!shader) { recordGlError(b, 0x505); return; }
    shaderTypes.set(shader, type);
    b.shaders.set(name, shader);
    transferNativeRetirement(receiver);
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x505);
  } finally { retireNativeRetirement(receiver); }
}

export function createProgramIfAccepted(b: GlBinding, name: number): void {
  if (!b.gl) return;
  if (!name || b.shaders.has(name) || b.programs.has(name)) {
    recordGlError(b, 0x502); return;
  }
  const receiver = reserveNativeRetirement(b, [["deleteProgram", null]]);
  if (!receiver) return;
  let metadata = false;
  try {
    const shaders = new Set<number>();
    const accepted = checkedGlCall(b, () => { receiver.calls[0][1] = b.gl!.createProgram(); });
    const program = receiver.calls[0][1] as WebGLProgram | null;
    if (!accepted) return;
    if (!program) { recordGlError(b, 0x505); return; }
    b.programShaders.set(name, shaders); metadata = true;
    b.programs.set(name, program);
    failedLinks.add(program);
    transferNativeRetirement(receiver);
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x505);
  } finally {
    if (!receiver.complete && metadata) b.programShaders.delete(name);
    retireNativeRetirement(receiver);
  }
}

/** Reserve at most two old executables before a switch can orphan either.
 * This owner contains only native handles and the original error queue. */
function reserveExecutableRelease(b: GlBinding, first: WebGLProgram | null,
    second: WebGLProgram | null = null): NativeRetirement | null {
  const calls: NativeDeletion[] = [];
  if (first) calls.push(["deleteProgram", first]);
  if (second && second !== first) calls.push(["deleteProgram", second]);
  // Bindings and query pins strongly retain their actual object group. The
  // retry receiver only needs a weak eligibility guard, never a guest binding.
  return reserveNativeRetirement(b, calls, [], {
    uninstallPrograms: true, unusedProgramOwners: b.objects,
  });
}

/** One private synchronous sequence on one physical context/error owner.
 * Every callback must be a single native GL operation: no host callouts,
 * nested execution, await, owner switches or unchecked work between steps.
 * Drain pending flags once, then check EVERY operation before its dependent
 * successor. A successful post-check is already the next step's clean entry.
 * The sequence and its callbacks never enter a cache or a repair record. */
/** Calls that form one step, checked once: one clean entry, every call,
 * one getError. A failed call has no effect in GL, so later calls act on the
 * state before it and the step as a whole is refused; the caller's inverse
 * restores whatever the accepted calls changed. A throw stops the step.
 * Calls must not depend on an earlier call's acceptance (a selector whose
 * failure would redirect a later write belongs in its own check).
 * `cleanEntry`: the caller's previous check of this owner was clean. */
export function checkedGlGroup(b: CheckedGlOwner, calls: readonly (() => void)[], cleanEntry = false): boolean {
  if (predictsNativeCalls(b)) return predictedNativeCalls(calls);
  const gl = b.gl;
  if (!gl) return false;
  try {
    let cleared = cleanEntry;
    if (!cleared) for (let i = 0; i < 32; i++) {
      const error = gl.getError();
    observeBatchNativeError(gl, error);
      if (error === 0) { cleared = true; break; }
      recordGlError(b, error);
    }
    if (!cleared) return false;
    for (const call of calls) call();
    const error = gl.getError();
    observeBatchNativeError(gl, error);
    recordGlError(b, error);
    return error === 0;
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502); // INVALID_OPERATION
    return false;
  }
}

/** Drain pending flags into `b`. True once they are clear: the caller's
 * next checkedGlGroup(…, true) on this owner starts from a clean entry. */
export function clearGlErrors(b: CheckedGlOwner): boolean {
  if (predictsNativeCalls(b)) return true;
  const gl = b.gl;
  if (!gl) return false;
  try {
    for (let i = 0; i < 32; i++) {
      const error = gl.getError();
    observeBatchNativeError(gl, error);
      if (error === 0) return true;
      recordGlError(b, error);
    }
    return false;
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502);
    return false;
  }
}

/** Checked groups in order, each a checkedGlGroup: a group runs only after
 * every earlier group was accepted, so a call that depends on an earlier
 * call's acceptance belongs in a later group. Empty groups are skipped.
 * `cleanEntry` as for checkedGlGroup; every accepted group is the next
 * group's clean entry. */
export function checkedGlGroups(b: CheckedGlOwner, groups: readonly (readonly (() => void)[])[], cleanEntry = false): boolean {
  let clean = cleanEntry;
  for (const group of groups) {
    if (!group.length) continue;
    if (!checkedGlGroup(b, group, clean)) return false;
    clean = true;
  }
  return true;
}

/** One call issued right after a clean check of the same owner: no entry
 * drain is needed, only its own post-check. */
export function checkedGlCallAfterClean(b: CheckedGlOwner, call: () => void): boolean {
  if (predictsNativeCalls(b)) return predictedNativeCalls([call]);
  const gl = b.gl;
  if (!gl) return false;
  try {
    call();
    const error = gl.getError();
    observeBatchNativeError(gl, error);
    recordGlError(b, error);
    return error === 0;
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502);
    return false;
  }
}

export function checkedGlSequence(b: CheckedGlOwner, calls: readonly (() => void)[]): boolean {
  if (predictsNativeCalls(b)) return predictedNativeCalls(calls);
  const gl = b.gl;
  if (!gl) return false;
  try {
    let cleared = false;
    for (let i = 0; i < 32; i++) {
      const error = gl.getError();
    observeBatchNativeError(gl, error);
      if (error === 0) { cleared = true; break; }
      recordGlError(b, error);
    }
    if (!cleared) return false;
    for (let i = 0; i < calls.length; i++) {
      calls[i]();
      const error = gl.getError();
    observeBatchNativeError(gl, error);
      recordGlError(b, error);
      if (error !== 0) return false;
    }
    return true;
  } catch (error) { rethrowNativeGlFault(error);
    if (isKernelExportFailure(error)) throw error;
    recordGlError(b, 0x502); // INVALID_OPERATION
    return false;
  }
}

export function finalizeShader(b: GlBinding, name: number): void {
  if (!b.shaderDeletePending.has(name)) return;
  for (const attached of b.programShaders.values()) if (attached.has(name)) return;
  const shader = b.shaders.get(name);
  if (shader && !checkedGlCall(b, () => b.gl!.deleteShader(shader), "cleanup")) {
    if (!rendererEverLost(b.gl!)) nativeGlFault("the live renderer refused deleteShader of a retired shader");
    return;
  }
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
  if (shaders) for (const shader of shaders) finalizeShader(b, shader);
  return true;
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

/** Uninstall and delete a program no name, pin or member uses any more.
 * A live renderer that refuses either step is a NativeGlFault: nothing
 * retries it later. A renderer that has been lost already lost the program,
 * and its bindings report the loss (renderer-loss.ts). */
function deleteUnusedNativeProgram(b: GlBinding, program: WebGLProgram): boolean {
  const gl = b.gl!;
  if (!checkedGlCall(b, () => {
    if (gl.getParameter(0x8b8d) === program) gl.useProgram(null);
  }, "cleanup") && !rendererEverLost(gl)) nativeGlFault("the live renderer refused to uninstall a program before deleting it");
  if (!checkedGlCall(b, () => gl.deleteProgram(program), "cleanup") && !rendererEverLost(gl))
    nativeGlFault("the live renderer refused deleteProgram of a program no owner uses");
  releaseReversedDepthTwin(b, program);
  return true;
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
  const gl = b.gl, previous = b.programs.get(name);
  if (!gl || !previous) {
    recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501); return;
  }
  const currentName = currentProgramName(b), installed = b.currentProgram;
  // An aliasing executable holds a private vertex shader, never the guest's
  // attachments, so it is never relinked in place.
  const clone = attributeAliasLayout(previous) !== undefined || b.programQueryPins.has(previous) ||
    [...b.objects.members].some(member => previous === member.currentProgram);
  const released = reserveExecutableRelease(b, previous, installed);
  if (!released) return;
  let candidate: NativeRetirement | null = null;
  let program = previous;
  let primaryFailure: unknown, failed = false;
  try {
    if (clone) {
      candidate = reserveNativeRetirement(b, [["deleteProgram", null]]);
      if (!candidate) return;
    }
    if (candidate) {
      const slot = candidate.calls[0];
      const allocated = checkedGlCall(b, () => { slot[1] = gl.createProgram(); });
      const native = slot[1] as WebGLProgram | null;
      if (!allocated) return;
      if (!native) { recordGlError(b, 0x505); return; }
      program = native;
      if (!checkedGlCall(b, () => {
        for (const shaderName of b.programShaders.get(name) ?? []) {
          const shader = b.shaders.get(shaderName);
          if (shader) gl.attachShader(program, shader);
        }
        for (const [attribute, index] of b.programAttributeBindings.get(name) ?? []) {
          gl.bindAttribLocation(program, index, attribute);
        }
      })) return;
    }
    const generation = programLinkGeneration(b, program);
    if (generation.value >= Number.MAX_SAFE_INTEGER) { recordGlError(b, 0x505); return; }
    const attached: WebGLShader[] = [];
    for (const shaderName of b.programShaders.get(name) ?? []) {
      const shader = b.shaders.get(shaderName);
      if (shader) attached.push(shader);
    }
    // One language version per program (essl3-translation.ts). A translated
    // program's attributes have native names; WebGL applies bindings at link.
    let translated = false;
    if (!checkedGlCall(b, () => {
      translated = prepareLinkLanguages(gl, attached);
      if (translated) for (const [attribute, index] of b.programAttributeBindings.get(name) ?? []) {
        const native = nativeInterfaceName(attribute);
        if (native !== attribute) gl.bindAttribLocation(program, index, native);
      }
      gl.linkProgram(program);
    })) return;
    generation.value++;
    recordProgramLanguage(program, translated);
    let linked = false;
    const queried = checkedGlCall(b, () => { linked = !!gl.getProgramParameter(program, 0x8b82); });
    recordLinkedProgram(b, program, queried && linked, attached);
    recordLinkedExternalSamplers(program, queried && linked, attached);
    // ES 2.0 allows attribute aliasing that WebGL rejects at link time. The
    // private executable then replaces the failed native object, which is
    // retired with the candidate or the released previous executable.
    const aliased = queried && !linked ? linkAliasedExecutable(b, name, attached) : null;
    const executable = aliased ?? program;
    if ((queried && linked) || aliased) failedLinks.delete(executable); else if (queried) failedLinks.add(program);
    if (aliased) { programLinkGeneration(b, aliased).value++; copyExternalSamplers(program, aliased); }
    b.programs.set(name, executable);
    // Locations are numbered per executable; an identical relink keeps the
    // previous link's numbering (uniform-layout.ts).
    noteProgramRelinked(previous, executable);
    if (candidate && !aliased) transferNativeRetirement(candidate);
    if (currentName === name) b.currentProgramId = name;
    if ((queried && linked) || aliased) {
      if (currentName === name && checkedGlCall(b, () => gl.useProgram(executable))) {
        b.shadow.currentProgram = b.currentProgram = executable;
      }
    }
  } catch (error) {
    // A fatal fault is the primary failure: cleanup in finally must not
    // replace it.
    if (isKernelExportFailure(error) || error instanceof NativeGlFault) { primaryFailure = error; failed = true; throw error; }
    recordGlError(b, 0x505);
  } finally {
    try {
      try { if (candidate) retireNativeRetirement(candidate); }
      finally { retireNativeRetirement(released); }
    } finally { if (failed) throw primaryFailure; }
  }
}

export function useProgramIfAccepted(b: GlBinding, name: number): void {
  const program = name === 0 ? null : b.programs.get(name);
  if (program === undefined) {
    recordGlError(b, b.shaders.has(name) ? 0x502 : 0x501); return;
  }
  const linkError = useProgramError(program, program === null || !failedLinks.has(program));
  if (linkError) { recordGlError(b, linkError); return; }
  const previous = b.currentProgram, previousName = currentProgramName(b);
  const wasRetained = previous !== null && b.programs.get(previousName) !== previous;
  const released = wasRetained ? reserveExecutableRelease(b, previous) : null;
  if (wasRetained && !released) return;
  let primaryFailure: unknown, failed = false;
  try {
    if (!checkedGlCall(b, () => b.gl!.useProgram(program))) return;
    b.currentProgram = program;
    b.currentProgramId = name;
    b.shadow.currentProgram = program;
    if (previous !== program && previousName !== 0) finalizeProgram(b, previousName);
  } catch (error) { primaryFailure = error; failed = true; throw error; }
  finally {
    try { if (released) retireNativeRetirement(released); }
    finally { if (failed) throw primaryFailure; }
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
    } catch (error) { rethrowNativeGlFault(error); if(isKernelExportFailure(error)) throw error;
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
