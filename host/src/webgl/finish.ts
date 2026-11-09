/**
 * glFinish (OpenGL ES 2.0 section 5.1): "Finish does not return until all
 * effects from previously issued commands on GL client and server state and
 * the framebuffer are fully realized." QOP_FINISH reaches the host after it
 * has decoded every earlier command of the session, so completing the
 * physical WebGL context here is that point for the guest. glFinish and
 * eglWaitClient/eglWaitGL both arrive here.
 *
 * WebGL defines finish() by reference to that same section, with no WebGL
 * relaxation. Firefox's finish() is a synchronous round trip to its GPU
 * process. Chromium's finish() is a flush ("Intentionally a flush, not a
 * finish", WebGLRenderingContextBase::finish), and WebKit sends Finish to
 * its GPU process as an asynchronous message, so on both engines finish()
 * returns while earlier draws are still executing (registry entries
 * CHROMIUM-WEBGL-FINISH-RETURNS-EARLY and WEBKIT-WEBGL-FINISH-RETURNS-EARLY).
 *
 * The completion below waits instead. WebGL 2.0 makes getBufferSubData
 * block until every earlier write into its source buffer has finished, and
 * a 4-byte copyBufferSubData between two private buffers is such a write,
 * issued after all of the guest's commands. On both affected engines one
 * physical context executes its commands in order, so the copy completes
 * only after them; measured on macOS, a read of a framebuffer after this
 * completion costs under 1 ms where 270-350 ms of earlier draws remained
 * after finish() alone. In-order completion is observed, not a WebGL
 * guarantee: Firefox let a clear of an unrelated framebuffer complete
 * before earlier draws. Firefox's finish() needs no such help, so the
 * completion is used only where finish() returns early.
 *
 * WebGL fences cannot do this: a sync object becomes signaled only between
 * tasks (WebGL 2.0 getSyncParameter), and the kernel worker answers this
 * query inside one task. A readback of the guest's framebuffer would depend
 * on its pack state, read buffer, sample count and format, would force a
 * multisample resolve, and covers only rendering into that framebuffer.
 * The buffer copy touches no pixel state, no framebuffer binding and no
 * presented image: it changes only the two copy bindings, which
 * withBufferTransfer restores.
 */
import type { GlBinding } from "./registry.js";
import { checkedGlCall } from "./program-objects.js";
import { withBufferTransfer } from "./buffer-storage.js";
import { rendererLossCount } from "./renderer-loss.js";

const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, STATIC_DRAW = 0x88e4;
const COMPLETION_BYTES = 4;

/** Whether this engine's WebGL finish() can return before earlier commands
 * complete. Blink (Chromium, Edge, ...) and WebKit (Safari, every iOS
 * browser) both carry "AppleWebKit/" in their user agent; Gecko does not.
 * [RUNTIME-WORKAROUND: CHROMIUM-WEBGL-FINISH-RETURNS-EARLY]
 * [RUNTIME-WORKAROUND: WEBKIT-WEBGL-FINISH-RETURNS-EARLY] */
export function webglFinishReturnsEarly(userAgent: string | undefined): boolean {
  return userAgent !== undefined && /AppleWebKit\//.test(userAgent);
}

const NATIVE_FINISH_RETURNS_EARLY = webglFinishReturnsEarly(
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent);

/** Two private 4-byte buffers per physical context and loss generation. A
 * lost context invalidates them, even after it is restored. */
type CompletionBuffers = { losses: number; source: WebGLBuffer; destination: WebGLBuffer; sized: boolean };
const completionBuffers = new WeakMap<WebGL2RenderingContext, CompletionBuffers>();
const completionBytes = new Uint8Array(COMPLETION_BYTES);

function buffersFor(b: GlBinding): CompletionBuffers | null {
  const gl = b.gl!, losses = rendererLossCount(gl);
  const existing = completionBuffers.get(gl);
  if (existing && existing.losses === losses) return existing;
  let source: WebGLBuffer | null = null, destination: WebGLBuffer | null = null;
  if (!checkedGlCall(b, () => { source = gl.createBuffer(); destination = gl.createBuffer(); })
      || !source || !destination) {
    if (source) checkedGlCall(b, () => gl.deleteBuffer(source));
    if (destination) checkedGlCall(b, () => gl.deleteBuffer(destination));
    return null;
  }
  const created: CompletionBuffers = { losses, source, destination, sized: false };
  completionBuffers.set(gl, created);
  return created;
}

/** Wait until every command issued on the physical context has completed. */
function awaitIssuedCommands(b: GlBinding): boolean {
  const gl = b.gl!;
  const buffers = buffersFor(b);
  if (!buffers) return false;
  return withBufferTransfer(b, buffers.source, buffers.destination, () => {
    if (!buffers.sized) {
      if (!checkedGlCall(b, () => {
        gl.bufferData(COPY_READ, COMPLETION_BYTES, STATIC_DRAW);
        gl.bufferData(COPY_WRITE, COMPLETION_BYTES, STATIC_DRAW);
      })) return false;
      buffers.sized = true;
    }
    return checkedGlCall(b, () => {
      gl.copyBufferSubData(COPY_READ, COPY_WRITE, 0, 0, COMPLETION_BYTES);
      gl.getBufferSubData(COPY_WRITE, 0, completionBytes);
      if (gl.isContextLost()) throw new Error("Renderer lost during completion");
    });
  });
}

/** QOP_FINISH: true once every earlier command of the physical context has
 * completed. A lost renderer fails loudly; it never reports completion. */
export function finishRenderer(b: GlBinding, finishReturnsEarly = NATIVE_FINISH_RETURNS_EARLY): boolean {
  const gl = b.gl!;
  return checkedGlCall(b, () => {
    if (gl.isContextLost()) throw new Error("Cannot finish a lost renderer");
    gl.finish();
    if (gl.isContextLost()) throw new Error("Renderer lost during completion");
  }) && (!finishReturnsEarly || awaitIssuedCommands(b));
}
