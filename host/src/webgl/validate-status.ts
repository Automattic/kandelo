/**
 * [RUNTIME-WORKAROUND: FIREFOX-VALIDATE-UNLINKED-PROGRAM] Firefox (WebGL 2 on
 * macOS) sets VALIDATE_STATUS to TRUE when ValidateProgram is called on a
 * program whose last link failed, or that was never linked. ValidateProgram
 * checks whether the program's executables can execute in the current state;
 * TRUE guarantees that the program executes and FALSE that it does not
 * (OpenGL ES 2.0 glValidateProgram). A program without a successfully linked
 * executable cannot execute (drawing with it is INVALID_OPERATION), so
 * VALIDATE_STATUS must be FALSE. The registry entry holds the standalone,
 * self-judging reproduction.
 *
 * ValidateProgram records whether the program had a linked executable at
 * that moment, read from the same native LINK_STATUS the guest is answered
 * with; a GetProgramiv(VALIDATE_STATUS) after a validation without one
 * answers FALSE. Chromium and WebKit already answer FALSE there, so their
 * answers are unchanged; it runs on every engine, at the cost of one
 * LINK_STATUS query per ValidateProgram.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";

const validatedWithoutExecutable = new WeakSet<WebGLProgram>();

/** After a native ValidateProgram the engine accepted. */
export function recordProgramValidation(b: GlBinding, program: WebGLProgram): void {
  let linked = true;
  // A failed query records its error; the native answer then stands.
  if (!checkedGlCall(b, () => { linked = !!b.gl!.getProgramParameter(program, 0x8b82); })) linked = true;
  if (linked) validatedWithoutExecutable.delete(program); else validatedWithoutExecutable.add(program);
}

/** The last ValidateProgram found no linked executable. */
export function validationHadNoExecutable(program: WebGLProgram): boolean {
  return validatedWithoutExecutable.has(program);
}
